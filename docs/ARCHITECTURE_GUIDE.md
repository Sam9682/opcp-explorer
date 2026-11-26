# OPCP-explorer Architecture Guide

This guide describes the architecture of the OPCP-explorer control plane: its components,
how a request moves through them, how an application is deployed, the data model,
configuration, security and logging. It describes the current code. Use the references
at the end for more detail on specific subsystems.

The display name comes from `PLTF_NAME` in `conf/deploy.ini` (default
`agentic-ai-plateform`). The installation folder is `PLTF_FOLDER` and the Linux user is
`LINUX_USER_INSTALLATION`, so the platform lives in
`/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>`.

---

## 1. Overview

OPCP-explorer is a Flask control plane. It clones Git repositories into per-user
deployment folders, runs them as Docker workloads through a standard script
(`deployApp.sh`), and publishes each user's copy under
`https://<DOMAIN>/<username>/<app>/` behind nginx. Around this core it adds:

- AI agents that change code and run operations;
- billing;
- a serverless job queue;
- a light container orchestrator;
- multi-server replication;
- MIG GPU sharing;
- a template marketplace and a sandbox.

You can use the platform through the web dashboard, the REST API, the CLI
(`python3 scripts/controller_cli.py`) and an MCP server (`scripts/mcp_server.py`).

```
                    Browser / CLI / MCP client / AI agent
                                  |
                                  | HTTPS :443
                                  v
 +---------------------------------------------------------------------------+
 | nginx (+ ModSecurity WAF when available)                                  |
 |   /                 -> gunicorn 127.0.0.1:5000 (Flask control plane)      |
 |   /gitea/           -> Gitea :3000                                        |
 |   /<user>/<app>/    -> per-user app container (dynamic location blocks)  |
 +-----------+------------------------------+--------------------------------+
             |                              |
             v                              v
 +--------------------------------+   +-------------------------------------+
 | Flask app (wsgi.py ->          |   | User applications                   |
 |  create_app())                 |   | /home/<LINUX_USER_INSTALLATION>/    |
 |  blueprints: main, auth, sso,  |   |   deployments/<user>/<app>/         |
 |  api, genai, billing,          |   |   deployApp.sh start|stop|...       |
 |  orchestrator, replication,    |   |   -> docker compose / docker run    |
 |  security, serverless, gpu,    |   |      (runtime runc | kata)          |
 |  templates, wizard, sandbox    |   +-------------------------------------+
 |  background threads:           |
 |   - orchestrator reconcile 30s |   +-------------------------------------+
 |   - replication worker         |   | Serverless worker (systemd,         |
 +------+------------+------------+   |  python3 -m src.serverless.worker)  |
        |            |                |  polls serverless_jobs, runs        |
        |            | subprocess     |  containers via Docker/Podman       |
        |            v                +------------------+------------------+
        |   AI engine CLI (kiro-cli/qchat or shai)       |
        |   prompts from shared/*_context.md             |
        v                                                v
 +---------------------------------------------------------------------------+
 | PostgreSQL (users, applications, user_applications, deployments,          |
 |  servers, services, instances, billing, configuration, serverless_jobs...)|
 +---------------------------------------------------------------------------+
        ^
        | HTTPS POST /api/sync/replicate (X-Sync-Token) between peer servers
        v
   other OPCP-explorer servers (PRIMARY / SECONDARY)
```

---

## 2. Components

### 2.1 Flask application

| Element | Role |
|---------|------|
| `wsgi.py` | Production entry point. Loads `.env`, calls `init_db()`, then `create_app()`, and exposes `application`. |
| `gunicorn.conf.py` | Binds `127.0.0.1:5000`. Starts `2 × CPU + 1` sync workers with a 1800 s timeout (long AI runs) and `preload_app = True`, runs as a daemon with PID file `conf/gunicorn.pid`, and writes `logs/gunicorn_access.log` and `logs/gunicorn_error.log`. Started by `deployControlPlan.sh` as `gunicorn --config gunicorn.conf.py wsgi:application`. |
| `ControlPlanFlaskApp.py` → `src/main.py` | Development entry point (Flask built-in server), also used by the `Dockerfile`. |
| `src/ControlPlanFlaskApp_postgres.py` | `create_app()` factory: sets `SECRET_KEY` and CORS, runs `init_db()`, starts the orchestrator reconciliation loop and the replication worker (a failure in either is logged and the app keeps running), registers `get_text()` for EN/FR translations (session `language`, default `fr`), and registers all blueprints. It also redirects `print()` to `logs/print_output_swautomorph.log`. |
| `src/config_postgres.py` | Reads `conf/deploy.ini` (`PLTF_NAME`, `PLTF_FOLDER`, `DOMAIN`, `VERSION`, `LINUX_USER_INSTALLATION`), PostgreSQL environment variables, timeouts, the default AI engine and the `TRANSLATIONS` dictionary. |
| `src/database_postgres.py` | `psycopg2` connection pool (`db_manager`), schema creation and migrations (`init_db`), port calculation (`calculate_app_ports`), and the `configuration` table helpers (`get_runtime_type`). |
| `src/admin_auth.py` | Admin rights: `username = 'admin'` or `account_type = 'ADMIN'`. |

### 2.2 Blueprints (`src/routes/`)

| Blueprint | Prefix | Responsibility |
|-----------|--------|----------------|
| `main_routes` | `/` | Login page, `/dashboard`, `/set_language/<lang>`, `/docs`, `/docs/<file>.md`, `/userguide`, GPU page `/servers/<id>/gpu` |
| `auth_routes` | `/` | `/register`, `/login` (with 2FA step), `/logout`, `/auth/sso` |
| `sso_routes` | `/sso` | SSO token validation and redirects to applications |
| `security_routes` | `/security` | Password change and reset, TOTP and email 2FA |
| `api_routes` | `/api` | Applications, users (including `POST /api/users/<id>/admin`), servers, deployments (clone/start/stop/...), database tables, configuration, nginx sync, backups |
| `genai_routes` | `/api` | Virtual agents: `/api/request_dev_ai_for_app`, `/api/request_ops_ai_for_app` (Server-Sent Events streams) |
| `billing_routes` | `/api/billing` | Activities, summary, costs, invoices (including PDF) |
| `orchestrator_routes` | `/api/orchestrator` | Services, scaling, health checks, nginx config/reload, reconcile, multi-user deploy |
| `replication_routes` | `/api/sync` | Receive replication events, health, status |
| `serverless_routes` | `/api` | `/api/jobs*`, `/api/serverless-links` |
| `gpu_routes` | `/api/servers/<id>/gpu` | MIG profiles and instances |
| `templates_routes` | `/api` | `/api/templates`, `/api/templates/<id>/deploy` |
| `wizard_routes` | `/api/wizard` | Setup wizard steps, SSL generate/upload, reset |
| `sandbox_routes` | `/api/sandbox` | Provision, reset, teardown, status |

All endpoints are listed in [API Reference](API_REFERENCE.md).

### 2.3 Front end

The front end uses Jinja templates in `templates/` (`base.html` navigation, `dashboard.html`
single-page dashboard, `login.html`, `register.html`, `doc_viewer.html`, `shared_gpu.html`,
`password_reset.html`) and static files in `static/` (`css/style.css`, `js/app.js`,
`js/dashboard_functions.js`). The dashboard is described in the
[User Guide](USER_GUIDE.md).

### 2.4 Platform services

| Component | Description |
|-----------|-------------|
| **nginx** | Terminates TLS for `DOMAIN` and `www.DOMAIN` (certificates in `ssl/<domain>/`) and redirects HTTP to HTTPS. Proxies `/` to gunicorn and `/gitea/` to Gitea. `SECONDARY_DOMAINS` adds one server block per extra domain. Per-user application routes are inserted as `location /<user>/<app>/` blocks by `src/nginx_manager.py`, which proxies to the live container port and rewrites redirects and asset paths. See `docs/technicals/NGINX_AND_DOMAINS.md`. |
| **ModSecurity** | OWASP CRS WAF, enabled in the main server block (`modsecurity on`) when the module is installed (`setup_modsecurity_config.sh`). Without it, nginx runs as a plain reverse proxy. |
| **Gitea** | Local Git server (systemd service, port 3000, version 1.21.3 when installed by `deployControlPlan.sh`). It holds the branches created by the Virtual Developer. Configuration is in `src/gitea_config.py` and `src/create_gitea_repo.py`. |
| **PostgreSQL** | System database. Connection settings come from `POSTGRES_*` environment variables. See [section 5](#5-data-model). |
| **Docker** | Runs user applications (through each app's `deployApp.sh`), orchestrator replicas and serverless jobs. The runtime is `runc` or `kata`. |
| **AI engine** | External CLI started as a subprocess by `genai_routes`: `kiro-cli`/`qchat` (default) or `shai`, selected by the `agentic_engine` configuration key. Prompts are built from `shared/<ACTION>_context.md` files. `shared/` is a git submodule that `init_pltf.sh` adds from `SUBMODULE_URL`. See `docs/technicals/VIRTUAL_AGENTS.md`. |

### 2.5 Background workers

| Worker | Where it runs | What it does |
|--------|---------------|--------------|
| **Orchestrator reconciliation loop** (`src/orchestrator.py`, `LightOrchestrator`) | Thread started by `create_app()` | Every 30 s: health-checks instances, reconciles each service's replica count, and regenerates nginx upstreams. Services that come from a Git URL are deployed per user instead of with `docker run`. See `docs/technicals/ORCHESTRATOR.md`. |
| **Replication worker** (`src/replication_manager.py`) | Thread started by `create_app()` | Takes write events from a queue and POSTs them to peer servers (`/api/sync/replicate`, authenticated with `X-Sync-Token` = `SYNC_SECRET`). Replicates the business tables (users, servers, applications, user_applications, application_costs, payment_modes, auth_tokens). Primary and secondary roles are handled in `platform_discovery.py` and `db_sync.py`. See `docs/technicals/REPLICATION.md`. |
| **Serverless worker** (`src/serverless/worker.py`) | Separate process: systemd unit `systemd/serverless-worker.service`, installed by `scripts/install_worker_service.sh` | Claims `pending` jobs with `FOR UPDATE SKIP LOCKED`, runs them in containers with limits from `conf/serverless.ini` (registry whitelist, memory/CPU, timeouts, log retention), and stores logs and results. Reads `runtime_type` once at startup. See [Serverless](SERVERLESS.md). |

### 2.6 Other modules

| Module | Role |
|--------|------|
| `src/template_catalog.py`, `src/template_deploy.py` | The template catalog is loaded and validated from the `deploy_templates` table (seeded by `migration/add_deploy_templates.sql`: `static-site`, `fastapi-starter`, `n8n`, `ollama`, `jupyter`, `vector-db`). `TemplateDeployService` is the single deploy path shared by the dashboard Marketplace, the REST API, the CLI, MCP and the sandbox. It registers the application, allocates ports, creates an orchestrator service and inserts the nginx route, and rolls back if any step fails. |
| `src/sandbox_manager.py` | Demo environment: creates a `sandbox demo` user and seeds 3 to 10 template applications (`deployments.is_sandbox = true`), with atomic provisioning and scoped reset/teardown. |
| `src/wizard/` + `src/configuration_writer.py` | Guided setup (steps `domain`, `email`, `gitea_version`, `ssl`, `admin_user`, `database`). Writes `conf/deploy.ini` with a timestamped backup, an atomic replace and a hashed admin password. `ssl_configurator.py` generates or uploads certificates. |
| `scripts/mcp_server.py` | Model Context Protocol server over stdin/stdout. Tools: `list_applications`, `add_application`, `get_user_info`, `list_users`, `deploy_template`. |
| `scripts/controller_cli.py` | CLI. Its lifecycle commands (`start`, `stop`, `restart`, `ps`, `logs`, `upgrade`, `backup-db`, `recover-db`, `migrate-db`, `version`) wrap `deployControlPlan.sh`. See [CLI Reference](CLI_REFERENCE.md). |
| `src/email_service.py` | SMTP email for password resets and 2FA codes. |
| `src/auth.py` | SSO tokens: SHA-256 hash stored in `auth_tokens`, 1-week lifetime. |
| `src/nginx_manager.py` | Creates and removes dynamic location blocks, finds the live ports of running containers, and runs `sync_all_locations`. |
| `src/db_health.py`, `src/query_converter.py` | Database health checks; converts `?` placeholders to `%s`. |

---

## 3. Request flow

1. The client connects to nginx on 443. ModSecurity, when enabled, inspects the request.
2. nginx forwards `/` to gunicorn on `127.0.0.1:5000` with `X-Forwarded-*` headers.
3. Flask routes the request to a blueprint. Most endpoints require `session['user_id']`
   (a signed session cookie) and return 401 otherwise. Admin endpoints run
   `ADMIN_CHECK_QUERY` (in `src/admin_auth.py`) and return 403 for non-admins.
4. The handler reads and writes PostgreSQL through `db_manager` (a connection pool).
   Writes to replicated tables are queued for peer servers.
5. Long operations (clone, start/stop, AI agents) return a `text/event-stream`
   response. The dashboard reads it progressively and shows the output live.
6. Requests to `/<user>/<app>/` never reach Flask. nginx proxies them directly to that
   user's application container.

---

## 4. Application deployment flow

### 4.1 Clone

The dashboard sends `POST /api/deployments` with `{"action": "clone", "git_url": ..., "server_id": ...}`.
It first gets a server from `POST /api/server/allocate`.

1. The target folder is
   `/home/<LINUX_USER_INSTALLATION>/deployments/<username>/<app-name-lowercase-dashed>`.
2. On the local server, the platform runs `git clone --recurse-submodules <git_url> <path>`.
   For a GitHub URL, any existing folder is deleted first. For a Gitea or localhost
   URL, an existing folder is updated with `git fetch` and `git checkout -B main origin/main`.
   On a remote server, the same steps run over SSH as `LINUX_USER_INSTALLATION`.
3. The nginx location block for `/<username>/<app>/` is inserted and SSL certificates
   are copied into the deployment.
4. A `deployments` row is created or updated with status `cloned`,
   `deployment_path`, `git_url` and `swautomorph_url = https://<DOMAIN>/<username>/<app>`.

### 4.2 Lifecycle: the `deployApp.sh` contract

`POST /api/deployments` with `action` set to `start`, `stop`, `restart`, `ps` or `logs`
looks up the latest deployment path and runs the script in that folder:

```
cd <deployment_path>
RUNTIME_TYPE=<runc|kata> ./deployApp.sh <action> <user_id> <user_name> <user_email> <runtime_type>
```

An application is **compliant** if it has an executable `deployApp.sh` at the root of
its repository that:

- accepts the actions `start`, `stop`, `restart`, `ps` and `logs`, with the positional
  arguments above;
- uses `RUNTIME_TYPE` (environment variable or 5th argument) as the container runtime,
  for example `docker run --runtime "$RUNTIME_TYPE"`;
- uses the 12-port layout below (the reference implementation is `shared/deployApp.sh`
  with `calculate_ports`);
- for `ps`, prints JSON containing `"docker_compose_ps": "IS_RUNNING"` or
  `"IS_NOT_RUNNING"`. The dashboard uses this value to choose which buttons to show.

If the file is missing, the API answers `deployApp.sh not found in ...`, and the
dashboard shows the application as **Not Compliant**. After each action, the
`deployments.status` column is updated (`RUNNING`, `STOPPED` or `COMPLETED`).

### 4.3 Port allocation

`calculate_app_ports(user_id, app_id)` in `src/database_postgres.py` gives every
(user, application) pair 12 consecutive ports:

```
base = RANGE_START + user_id * RANGE_RESERVED + app_id * RANGE_PORTS_PER_APPLICATION
       (defaults: 6000, 100, 12)

HTTPS_PORT  = base+0  (main web interface)   HTTP_PORT  = base+1
HTTPS_PORT1 = base+2                         HTTP_PORT1 = base+3
HTTPS_PORT2 = base+4                         HTTP_PORT2 = base+5
HTTPS_PORT3 = base+6                         HTTP_PORT3 = base+7
HTTPS_PORT4 = base+8                         HTTP_PORT4 = base+9
HTTPS_PORT5 = base+10                        HTTP_PORT5 = base+11
```

The ports are stored in `user_applications` (`https_port`, `http_port`,
`https_port2..6`, `http_port2..6`). `init_db()` fills in any rows that are missing
ports.

### 4.4 Other deployment paths

- **Templates and sandbox**: `TemplateDeployService` creates an orchestrator service
  instead of cloning a repository (see section 2.6).
- **Orchestrator services**: replicated services created from the Orchestrator page or
  `/api/orchestrator/services`.
- **Virtual agents**: `genai_routes` runs the AI engine with
  `HOME=/home/<LINUX_USER_INSTALLATION>`. After a successful `MODIFY_CODE` run, it
  records a Gitea branch `<user_id>-automorph-<app>-<timestamp>` in
  `deployments.gitea_branch_url` and `modification_history`. START and STOP requests
  sent through the operations agent are recorded in `billing_activities`.

---

## 5. Data model

The base schema is `scripts/postgresql_schema.sql`. `init_db()` loads it when the
`users` table is missing, then applies the idempotent migrations in `migration/`.

| Table | Purpose |
|-------|---------|
| `users` | Accounts: password hash, `suspended`, `account_type` (`ADMIN`, `sandbox demo`, ...), TOTP and email 2FA columns |
| `applications` | Application catalog: Git URL, Gitea URL, size, build/start/stop/ps durations, URL |
| `user_applications` | Assignment of applications to users, with the user's URL and the 12 ports |
| `deployments` | Per-user deployments: status, path, Git and Gitea branch URL, `swautomorph_url`, server, `modification_history`, `backups_history`, `is_sandbox` |
| `servers` | Deployment servers: IP, status (`STAND_BY`, `ACTIVE`, `STAND_ALONE`, `PRIMARY`, `SECONDARY`), capacity, `shared_gpu_enabled` |
| `services`, `instances` | Orchestrator desired state and running replicas (unique per `name, user_id`) |
| `application_costs`, `billing_activities`, `invoicing`, `payment_modes` | Billing: daily rate, start/stop activity with duration and cost, invoices |
| `auth_tokens` | Hashed SSO tokens |
| `users_logs` | User activity log |
| `configuration` | Runtime key/value settings (`agentic_engine`, `agentic_command`, `runtime_type`, ...) |
| `password_reset_tokens`, `twofa_email_codes` | Password reset (1 h) and email 2FA codes (5 min) |
| `serverless_jobs`, `serverless_job_logs`, `serverless_job_results` | Serverless queue |
| `mig_profiles`, `mig_instances` | MIG GPU sharing |
| `deploy_templates` | Marketplace templates |

Migrations, backups and recovery are covered in `docs/technicals/DATABASE.md` and
`docs/technicals/BACKUP_AND_RECOVERY.md`.

---

## 6. Configuration

### 6.1 `conf/deploy.ini`

Copy `conf/deploy.ini.template` to create this file. It is written by `init_pltf.sh`
or the setup wizard. Values are plain `KEY=value` lines, read by the Python code and
by `deployControlPlan.sh`.

| Key | Meaning |
|-----|---------|
| `DOMAIN` | Main domain: nginx `server_name`, application URLs |
| `PLTF_NAME` | Display name in the UI (default `agentic-ai-plateform`) |
| `PLTF_FOLDER` | Installation folder name, gunicorn process name, docker-compose container prefix |
| `VERSION` | Version shown in the navigation bar |
| `REPO_URL`, `SUBMODULE_URL` | Main repository and `shared` submodule sources used by `init_pltf.sh` |
| `LINUX_USER_INSTALLATION` | Linux user owning `/home/<user>/<PLTF_FOLDER>` and `/home/<user>/deployments` (default `psmc`) |
| `RANGE_PORTS_PER_APPLICATION` | Ports per application (12) |
| `RANGE_START`, `RANGE_RESERVED`, `RANGE_START_CONTROLPLAN`, `RANGE_RESERVED_CONTROLPLAN` | Port range bases (defaults 6000, 100, 80, 0) |
| `SECONDARY_DOMAINS` | Extra domains: `domain:server_names:proxy_pass`, comma-separated |
| `S3_BUCKET_NAME` | S3 bucket for backups |

### 6.2 Environment variables (`.env`, loaded by `python-dotenv`)

| Variable | Default | Used for |
|----------|---------|----------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `localhost`, `5432`, `ai_swautomorph`, `swautomorph`, `swautomorph_password` | Database connection |
| `POSTGRES_MIN_CONN`, `POSTGRES_MAX_CONN`, `POSTGRES_SSLMODE`, `POSTGRES_TIMEOUT` | `2`, `20`, `prefer`, `10` | Connection pool |
| `SECRET_KEY` | `dev-secret-key-change-in-production` | Flask session signing. **Must be changed.** |
| `SYNC_SECRET` | `default-sync-secret-change-me` | Replication `X-Sync-Token`. Must be the same on all peer servers. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `SMTP_USE_TLS` | `localhost`, `587`, empty, empty, ... , `true` | Password reset and 2FA emails |
| `FLASK_ENV` | `development` | `development` enables gunicorn reload |

### 6.3 Database `configuration` table

The `configuration` table holds settings that can be changed at runtime from
**Settings** in the dashboard or through `/api/configuration`:

- `agentic_engine` (default `kiro-cli`);
- `agentic_command` (empty by default; if set, agent requests run `deployControlPlan.sh <agentic_command>`);
- `runtime_type` (`runc` or `kata`; any other value falls back to `runc`).

`conf/serverless.ini` configures the serverless worker.

---

## 7. Security model

- **Transport**: nginx terminates TLS 1.2/1.3 and redirects HTTP to HTTPS. ModSecurity
  with OWASP CRS applies when the module is installed.
- **Authentication**: Flask signed session cookie (`SECRET_KEY`) and werkzeug password
  hashes. Self-registered accounts start suspended. Optional TOTP 2FA (with 8 one-time
  backup codes) or email 2FA. Password reset tokens are stored hashed and expire after
  1 hour.
- **Authorization**: two levels. A normal user only sees and operates applications
  assigned to them in `user_applications`, inside their own deployment folder. An admin
  (`admin`, or `account_type = 'ADMIN'`) can use the Configuration pages and the admin
  API. Only `admin` can grant or revoke admin rights (`POST /api/users/<id>/admin`).
- **SSO**: random token, stored as a SHA-256 hash in `auth_tokens`, valid for 1 week,
  validated by `/sso/validate`.
- **Inter-server**: replication endpoints require `X-Sync-Token` = `SYNC_SECRET`.
  Remote operations use SSH as `LINUX_USER_INSTALLATION`.
- **Isolation**: every user/application has its own folder and port range. Containers run
  with `runc` or, for stronger isolation, `kata` MicroVMs. Serverless jobs are limited by
  a registry whitelist and CPU/memory/time limits.
- **Input handling**: SQL uses parameterized queries. Agent action names are sanitized
  (alphanumeric and `_`) before a context file is loaded.
- **Unauthenticated by design**: the setup wizard API (`/api/wizard/*`) runs before any
  admin exists and has no session check. Restrict access to it once the platform is
  installed.

---

## 8. Logging

Everything is written under `logs/` in the platform folder:

| File | Content |
|------|---------|
| `gunicorn_access.log`, `gunicorn_error.log` | HTTP access and server errors |
| `print_output_swautomorph.log` | All `print()` output of the Flask process |
| `<module>.log` (`api_routes.log`, `genai_routes.log`, `billing_routes.log`, `gpu_routes.log`, `orchestrator_routes.log`, `serverless_routes.log`, `config_postgres.log`, ...) | Per-module Python logging |
| `dev_prompt_generated.txt`, `ope_prompts_generated.log` | Prompts sent to the AI engine |
| `serverless_worker.log` | Serverless worker |

`python3 scripts/controller_cli.py logs` shows the recent Flask, nginx or Docker logs.

---

## 9. Container packaging (`Dockerfile`, `docker-compose.yml`)

`deployControlPlan.sh` supports two modes: `locally` (the usual setup: host nginx,
gunicorn, systemd Gitea and PostgreSQL) and `docker`.

- **`Dockerfile`**: `python:3.11-slim` with git, the SSH client and the Docker CLI.
  It runs as user `ubuntu`, loads the SSH keys at start and runs
  `python3 ControlPlanFlaskApp.py`.
- **`docker-compose.yml`** defines four services on the `swautomorph-network`:
  - `postgres` (`postgres:15-alpine`, initialised from `scripts/postgresql_schema.sql`);
  - `app` (built from the Dockerfile, mounts `/var/run/docker.sock` and `~/.ssh`,
    publishes the six HTTP ports 6000–6010 to container port 80);
  - `nginx` (`nginx:alpine`, publishes the six HTTPS ports 6001–6011 to 443, mounts
    `conf/nginx.conf` and `ssl/`);
  - `gitea` (`gitea/gitea:1.21.3`, port 3000).

  Container names are prefixed with `PLTF_FOLDER`.

Installation and operations are covered in [Init Platform](INIT_PLATFORM.md) and
[Deployment Guide](DEPLOYMENT_GUIDE.md).

---

## 10. Further reading

- [Platform Overview](PLATFORM_OVERVIEW.md), [User Guide](USER_GUIDE.md),
  [CLI Reference](CLI_REFERENCE.md), [API Reference](API_REFERENCE.md)
- [Serverless](SERVERLESS.md), [Share GPU Docker](SHARE_GPU_DOCKER.md),
  [Available Applications](LIST_OF_APP_AVAILABLE.md)
- Technical notes (in the repository, `docs/technicals/`): `REPLICATION.md`,
  `NGINX_AND_DOMAINS.md`, `BACKUP_AND_RECOVERY.md`, `ORCHESTRATOR.md`, `DATABASE.md`,
  `VIRTUAL_AGENTS.md`, `TESTING.md`
