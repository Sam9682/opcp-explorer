# App Orchestrator

The App Orchestrator is a lightweight "desired state vs. actual state" manager built into OPCP-explorer. It tracks **services**, which are logical applications with a desired replica count, and **instances**, which are the running containers. It reconciles the two, health-checks the instances and generates nginx `upstream` blocks.

Related docs: [DATABASE.md](DATABASE.md) · [NGINX_AND_DOMAINS.md](NGINX_AND_DOMAINS.md) · [../API_REFERENCE.md](../API_REFERENCE.md) · [../SERVERLESS.md](../SERVERLESS.md)

| File | Role |
|---|---|
| `src/orchestrator.py` | `LightOrchestrator` class and the global `orchestrator` singleton |
| `src/routes/orchestrator_routes.py` | REST API, blueprint prefix `/api/orchestrator` |
| `templates/dashboard.html` | **Orchestrator** tab (admins only) |
| `scripts/orchestrator_cli.py` | Stand-alone CLI (currently broken, see §6) |
| `scripts/test_orchestrator.py`, `test_orchestrator_fix.sh` | Manual test helpers |

---

## 1. Data model

Both tables are created by `scripts/postgresql_schema.sql` (see [DATABASE.md](DATABASE.md)). `init_orchestrator_tables()` is now a no-op that's only kept for compatibility.

**`services`**: `id, name, image, user_id, desired_replicas, ports (JSON text), environment (JSON text), volumes (JSON text), health_check_path (default /health), created_at, updated_at`. Each name is unique per user (`UNIQUE(name, user_id)`).

**`instances`**: `id, service_id → services(id) ON DELETE CASCADE, instance_id ("<service>-replica-<n>"), server_id → servers(id), service_name, container_id, status (pending|running|failed|stopped), port, health_status (healthy|unhealthy|unknown), last_health_check, created_at, updated_at`. Each `instance_id` is unique per service (`UNIQUE(service_id, instance_id)`).

The `image` field holds either a Docker image reference or, when the service comes from the dashboard, a **Git URL**.

---

## 2. How it works

### Reconciliation

`_reconcile_service(name, user_id)` holds a lock and compares `desired_replicas` with the number of instances in `running` or `pending` state:

- **Too few instances:** it calls `_create_instance()` for each missing replica.
- **Too many instances:** it calls `_stop_instance()` on the extra ones. That runs `docker stop`, then `docker rm`, and deletes the instance row.

Reconciliation runs at these points:
- right after `create_service()` and `scale_service()`;
- when `POST /api/orchestrator/reconcile` is called;
- in a **background loop**. `create_app()` in `src/ControlPlanFlaskApp_postgres.py` calls `orchestrator.start_reconciliation_loop()` with the default interval of 30 s. Each pass runs `health_check_instances()`, reconciles every service and regenerates the nginx config. The generated config is only computed, never written to disk.

### Creating an instance

`_create_instance()` works as follows:

1. **Git-based services are skipped.** If `image` looks like a Git URL (it ends in `.git`, starts with `http(s)://` or `git@`, or contains github.com, gitlab.com, gitea or forgejo), no container is started. Those services are deployed with the app's own `deployApp.sh` (see §3).
2. **Scheduler:** `_select_server()` picks the `STAND_BY`/`ACTIVE` server with the fewest running instances that is still below `server_capacity_appli_max`. If that value is NULL, the limit defaults to 100.
3. **Port:** `_find_available_port()` returns the first port from 8000 upward that isn't already used by a running instance on that server.
4. It inserts an instance row as `pending`, then runs the following **locally**. Remote servers are not handled here.
   ```
   docker run -d --name <service>-replica-<n> [--runtime kata] -p <port>:<container_port> ... \
       -e K=V ... -v <vol> ... --restart unless-stopped <image>
   ```
   On success the row becomes `running` and stores the container ID. On failure it becomes `failed`.

### Container runtime (runc / kata)

The runtime comes from the top-level `configuration` row `runtime_type`, read by `get_runtime_type()` in `src/database_postgres.py`. Admins set it in **Settings → Container Runtime Type**.

- Allowed values are `runc` (the default) and `kata` (Kata Containers MicroVM). Any other value falls back to `runc` and logs a warning.
- `--runtime` is only added when the value isn't `runc`.
- The same setting is passed to per-app `deployApp.sh` deployments, both as the last positional argument and as the `RUNTIME_TYPE` env var. It's also used by serverless jobs (see [../SERVERLESS.md](../SERVERLESS.md)).

Kata must already be installed and registered as a Docker runtime on the host.

### Health checks

`health_check_instances()` sends `GET http://<server_ip>:<port><health_check_path>` (5 s timeout) to each running instance. A 200 response marks the instance `healthy`; anything else marks it `unhealthy`. Instances are not restarted automatically when they turn unhealthy.

### Nginx upstreams

`generate_nginx_config()` emits one block per service that has running instances whose health is `healthy` or `unknown`:

```nginx
upstream <service_name> {
    least_conn;
    server <server_ip>:<port>;
}
```

`reload_nginx()` runs `nginx -s reload`. The generated text isn't written to any file, so you include it in nginx yourself. Per-user application routing is handled separately by `src/nginx_manager.py` (see [NGINX_AND_DOMAINS.md](NGINX_AND_DOMAINS.md)).

---

## 3. Dashboard

The **🎯 Orchestrator** tab is visible to admins only: user `admin`, or users with `account_type = 'ADMIN'`. It contains:

- **A status panel** (`GET /status`) showing service count, instances by status and health, per-server utilization, and whether the reconciliation loop is running.
- **A services grid** (`GET /services`) with scale and delete actions.
- **A Create Service form:**
  - Application: a dropdown of the user's applications from `/user-applications`.
  - Git URL: a dropdown built from `/git-urls`, which collects the user's `deployments.gitea_branch_url` values and the `gitea_url` entries of `modification_history`.
  - Replicas (1–10), environment variables (JSON) and the health-check path.
  - **Deployment Mode:**
    - **🖥️ Multi-Server** sends `POST /services`. It records the service, picks a server and runs, over SSH:
      `cd /home/<LINUX_USER>/deployments/<username>/<app> && ./deployApp.sh start <user_id> <username>`
      It then writes instance rows and a billing `START` activity.
    - **👥 Multi-User Local** sends `POST /services/multi-user-deploy` (see below).
- **Nginx Configuration:** Generate Config (`GET /nginx/config`) and Reload Nginx (`POST /nginx/reload`).

### Multi-user deploy

`POST /api/orchestrator/services/multi-user-deploy` takes `{name, image: <git_url>, desired_replicas (1..10), environment, health_check_path}`. It requires `name` to be an existing application. For each `i` in `1..N` it:

1. Creates, or reuses, the user `<app-name-sanitized><i>` (email `<user>@<DOMAIN>`, auto-generated password).
2. Assigns the application to that user in `user_applications`, using ports from `calculate_app_ports()`.
3. Clones the repo with `git clone --recurse-submodules` into `/home/<LINUX_USER>/deployments/<user>/<app>`. If the folder already exists, it runs `git pull` instead. The clone is local when the first `STAND_BY`/`ACTIVE` server is this host, and goes over SSH otherwise.
4. Writes or updates a `deployments` row (`status='cloned'`, `swautomorph_url=https://<DOMAIN>/<user>/<app>`), then runs `deployApp.sh start <uid> <user>`. On success the status becomes `running`.

Finally it records a tracking `services` row for the calling admin with `desired_replicas = N`. Because `image` is a Git URL, reconciliation never runs `docker run` for it. The response contains `total_replicas`, `successful_deploys` and a per-user `created_users` list, where each status is one of `deployed`, `existing_redeployed`, `cloned_but_start_failed`, `existing_start_failed`, `clone_failed`, `failed_create` or `error: ...`.

---

## 4. REST API (`/api/orchestrator`)

"Auth" means any logged-in user. "Admin" uses `ADMIN_CHECK_QUERY` from `src/admin_auth.py`.

| Method & path | Access | Notes |
|---|---|---|
| `GET /user-applications` | Auth | `[{name}]`: the apps assigned to the current user |
| `GET /git-urls` | Auth | A sorted list of the user's Gitea branch URLs |
| `GET /services` | Auth | The current user's services, with their instances |
| `GET /services/<name>` | Auth | One service owned by the current user, or 404 |
| `POST /services` | Admin | `{name, image, desired_replicas?, ports?, environment?, volumes?, health_check_path?}`. Runs the Multi-Server flow (§3). Returns 201, or 500 if no server is available or the deploy fails. |
| `PUT /services/<name>` | Admin | `{desired_replicas}`. ⚠️ Broken: see §7. |
| `POST /services/<name>/scale` | Admin | `{replicas: int ≥ 0}` → `scale_service(name, session_user, replicas)` |
| `DELETE /services/<name>` | Admin | Stops and removes the instances, then deletes the service owned by the caller |
| `POST /services/multi-user-deploy` | Admin | See §3 |
| `POST /health-check` | Admin | Runs `health_check_instances()` |
| `POST /reconcile` | Admin | Reconciles every service |
| `GET /nginx/config` | Admin | `{config: "<upstream blocks>"}` |
| `POST /nginx/reload` | Admin | `nginx -s reload` |
| `GET /status` | Auth | `{total_services, instance_stats, health_stats, server_stats[], reconciliation_running}` |

Example:

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/orchestrator/services/web/scale \
     -H 'Content-Type: application/json' -d '{"replicas": 3}'
```

Route activity is logged to `logs/orchestrator_routes.log`.

---

## 5. Testing

- **`scripts/test_orchestrator.py`** builds the Flask app, then creates an `nginx:alpine` service called `test-nginx`, lists the services and prints the generated nginx config. It calls `create_service()` without `user_id`, so the create step currently fails and reports `❌ Error creating service`. The listing and nginx steps still run.
- **`test_orchestrator_fix.sh`** prints the row counts of `services`, `instances` and `billing_activities` with `psql -U swautomorph -d ai_swautomorph`, then explains how to create a service from the dashboard. Run `./test_orchestrator_fix.sh verify <service_name>` to display the matching service, instance and billing rows.

---

## 6. CLI (`scripts/orchestrator_cli.py`)

The script defines these argparse subcommands:

```
init | create <name> <image> [--replicas N] [--ports JSON] [--environment JSON] [--volumes JSON] [--health-check PATH]
     | scale <name> <replicas> | delete <name> | list | show <name> | health | nginx [-o FILE] | reload
```

> ⚠️ **The CLI doesn't work as shipped.** It runs `import database`, but `src/database.py` doesn't exist, and it imports `orchestrator` as a top-level module even though that module uses package-relative imports. Even with the imports fixed, `create`, `scale` and `delete` call the orchestrator without the required `user_id` argument. Use the dashboard or the REST API instead.

---

## 7. Known issues and limitations

- **`PUT /services/<name>` always fails.** It calls `scale_service(name, replicas)` without `user_id`, which raises a `TypeError` and returns 500. Use `POST /services/<name>/scale` instead.
- **`POST /services` (Multi-Server) writes instance rows without `service_id`.** That column is `NOT NULL`, so the insert fails. The error is logged and the instances aren't recorded, even though the deploy succeeded. The SSH `deployApp.sh` call also expects the app to already be cloned in the target user's folder.
- **`get_service_status()` maps instance columns by position, and the indexes are off.** `container_id`, `status`, `port`, `health_status`, `server_name` and `server_ip` are each read from the wrong column, so `/services`, the dashboard grid and the CLI `list` show shifted values.
- **Containers only start on the local host.** `_start_container()` runs `docker` locally even when the scheduler picked a remote server.
- **Port mapping uses one host port per instance.** If a service defines several container ports, every one is mapped to the same host `port`, so `docker run` fails when there is more than one.
- **No automatic restarts and no rolling updates.** Unhealthy instances are only marked as unhealthy.
