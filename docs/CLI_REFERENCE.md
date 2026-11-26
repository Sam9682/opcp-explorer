# CLI Reference

OPCP-explorer ships two command-line tools:

| Tool | Purpose |
|------|---------|
| `scripts/controller_cli.py` | Main CLI: platform lifecycle, database, users/apps, nginx, replication, sandbox, deploy templates, systemd install |
| `scripts/orchestrator_cli.py` | App Orchestrator services. **Currently broken** (bad imports, missing `user_id`); use the dashboard or `/api/orchestrator` instead. See [technicals/ORCHESTRATOR.md](./technicals/ORCHESTRATOR.md). |

Run them from the repository root, with the virtual environment active (`source .venv/bin/activate`). `controller_cli.py` loads database credentials from `.env` at the repository root.

```bash
python3 scripts/controller_cli.py --help            # list every command
python3 scripts/controller_cli.py <command> --help  # options of one command
```

`controller_cli.py` is a [click](https://click.palletsprojects.com/) group: Python function names map to dashed command names (`list_tables` → `list-tables`).

---

## Platform lifecycle

These commands are thin wrappers around `deployControlPlan.sh`. They run it from the repository root with your terminal attached, so its interactive menus still work, and they exit with its status code. You can still call `./deployControlPlan.sh <command>` directly; the equivalent script command is shown in the table.

| Command | Script equivalent | Description |
|---------|-------------------|-------------|
| `start [locally\|docker]` | `start` | Deploy and start all services (PostgreSQL init, Flask/Gunicorn, Nginx + ModSecurity, Gitea, firewall, nginx location sync, hourly backup cron) |
| `stop [locally\|docker] [--app-only\|--stop-all] [--keep-gitea-running]` | `stop` | Stop services and clean up (final DB backup, remove cron, stop app, optionally nginx/Gitea/containers) |
| `restart [locally\|docker]` | `restart` | Restart the app with a new PID, reload Nginx, restart containers in docker mode |
| `ps` | `ps` | Status of Flask, Nginx, Gitea and Docker Compose |
| `logs` | `logs` | Today's Flask logs, last Nginx errors, Docker Compose logs |
| `upgrade` | `upgrade` | Stash local changes, `git fetch --all`, merge from origin, restore the stash |
| `backup-db` | `backup_db` | Timestamped backup in `softfluid/db/backup/`, synced to S3 |
| `recover-db` | `recover_db` | Interactive restore from a local or S3 backup (backs up the current DB first) |
| `migrate-db` | `migrate_db` | Legacy SQLite → PostgreSQL migration. It does nothing unless `softfluid/db/ai_swautomorph.db` exists, and the Python migration script it calls has been removed. |
| `version` | `version` | Print `PLTF_NAME` and `VERSION` from `conf/deploy.ini` |

**Mode.** `locally` installs on the host (production). `docker` uses `docker-compose.yml` (development/testing). If you omit the mode for `start`/`stop`/`restart`, the script shows a selection menu.

**`start` options.** These set the admin identity the script uses for port calculation and logging. Values not given fall back to `DEFAULT_USER_ID`, `DEFAULT_USER_NAME`, `DEFAULT_USER_EMAIL` and `DEFAULT_DESCRIPTION`.

```bash
python3 scripts/controller_cli.py start locally
python3 scripts/controller_cli.py start locally --user-id 0 --user-name admin --user-email admin@example.com
```

**`stop` scope.**

| Flag | Effect |
|------|--------|
| *(none)* | Asks interactively. Defaults to "everything" in non-interactive shells. |
| `--app-only` | Stops only the control-plane web server (Gunicorn, or the `app` container). Nginx, the `/<user>/<application>` reverse proxies and Gitea keep running, so user applications stay reachable. |
| `--stop-all` | Stops everything without asking the scope |
| `--keep-gitea-running` | Answers "no" to the "stop Gitea?" question |

`--app-only` and `--stop-all` are mutually exclusive.

```bash
python3 scripts/controller_cli.py stop locally --app-only
python3 scripts/controller_cli.py stop locally --stop-all --keep-gitea-running
```

---

## Database

These commands connect directly to PostgreSQL using the `POSTGRES_*` settings. See [technicals/DATABASE.md](./technicals/DATABASE.md).

| Command | Description |
|---------|-------------|
| `init-db` | Create the schema, apply bundled migrations, seed default applications |
| `db-health` | Connection and table health check |
| `db-status [--show-env]` | Application/database status. `--show-env` also prints the environment settings. |
| `list-tables` | All tables with record counts |
| `describe-table [TABLE]` | Column definitions. Shows a picker if `TABLE` is omitted. |
| `select-table [TABLE] [--limit N]` | Show table rows (default 10) |
| `exec-sql-request "SQL"` | Execute an arbitrary SQL statement (asks for confirmation) |
| `delete-db` | **Permanently drop** the PostgreSQL database (asks for confirmation) |
| `mount-s3fs BUCKET MOUNT_POINT [--passwd-file .passwd-s3fs]` | Mount OVHcloud S3 storage with s3fs |

---

## Users, applications and SSO

| Command | Description |
|---------|-------------|
| `register --username U --email E --password P [--first-name F] [--last-name L]` | Register a user through the HTTP API |
| `list-apps` | List applications through the HTTP API |
| `add-app --name N --url GIT_URL [--description D]` | Insert an application directly into the `applications` table |
| `validate-token --token T` | Validate an SSO token through `/sso/validate` |

> **Note:** `register`, `list-apps` and `validate-token` send HTTP requests to `BASE_URL`, which is hardcoded at the top of `scripts/controller_cli.py`. Edit it to point at your own platform URL before using these three commands.

---

## Nginx, platform and replication

| Command | Description |
|---------|-------------|
| `update-nginx-locations` | Regenerate the per-user/per-app nginx `location` blocks from the database and reload nginx (same as `scripts/sync_nginx_locations.py`) |
| `platform-status` | This server's role and the known servers |
| `discover-server REMOTE_IP` | Check whether an OPCP-explorer instance answers at `REMOTE_IP` |
| `replication-sync-status` | Replication queue and sync status across servers |
| `replication-sync-table TABLE SERVER_IP` | Push one table to a peer |
| `replication-sync-all-tables SERVER_IP` | Push all replicated tables to a peer |
| `replication-test-sync SERVER_IP` | Test connectivity to a peer |

See [technicals/NGINX_AND_DOMAINS.md](./technicals/NGINX_AND_DOMAINS.md) and [technicals/REPLICATION.md](./technicals/REPLICATION.md).

---

## Sandbox and deploy templates

These commands use the same services as the dashboard, REST API and MCP server (`SandboxManager`, `TemplateCatalog`, `TemplateDeployService`).

| Command | Description |
|---------|-------------|
| `sandbox provision` | Create the demo account (`Demo_User`) and seed sample applications |
| `sandbox reset` | Remove the sample apps and re-seed the baseline |
| `sandbox teardown` | Stop and remove all demo resources |
| `templates list` | List deploy templates (identifier + application type) |
| `templates deploy TEMPLATE_ID APP_NAME --user-id ID` | Deploy a template as `APP_NAME` for user `ID` |

```bash
python3 scripts/controller_cli.py templates deploy fastapi-starter my-api --user-id 2
```

The template catalog is described in [LIST_OF_APP_AVAILABLE.md](./LIST_OF_APP_AVAILABLE.md).

---

## systemd

| Command | Description |
|---------|-------------|
| `install-as-systemctl-service` | Write `/etc/systemd/system/opcp-explorer-controlplan.service`, run `daemon-reload` and `enable`. Needs `sudo`. |

```bash
sudo python3 scripts/controller_cli.py install-as-systemctl-service
sudo systemctl start opcp-explorer-controlplan
```

The unit's `User=` and paths come from `LINUX_USER_INSTALLATION` and `PLTF_FOLDER` in `conf/deploy.ini`. The unit is rendered by `scripts/controlplan_service.py`. Check that the `ExecStart`/`ExecStop` scripts it references exist in `scripts/` before you enable it (see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md#run-as-a-systemd-service)).

---

## Other scripts

| Script | Purpose |
|--------|---------|
| `scripts/mcp_server.py` | MCP server for AI agents. Tools: `list_applications`, `add_application`, `get_user_info`, `list_users`, `deploy_template`. |
| `scripts/sync_nginx_locations.py` | Standalone nginx location sync |
| `scripts/generate_ssl.sh` | Self-signed certificate generator (writes to `ssl/`, not `ssl/<DOMAIN>/`) |
| `scripts/setup_letsencrypt.sh` | Let's Encrypt setup (hardcoded domain; writes `ssl/cert.pem` / `ssl/key.pem`) |
| `scripts/install_worker_service.sh` | Install the serverless worker systemd unit (see [SERVERLESS.md](./SERVERLESS.md)) |
| `scripts/fix_user_application_ports.py`, `scripts/fix_deployment_user_id.py` | One-off data repair helpers |
| `scripts/add_backup_to_deployment.py` | Record a backup in a deployment's history |
| `scripts/kill_flask.sh` | Kill stray Flask/Gunicorn processes |
| `scripts/reset_db.sh` | Reset the database |
| `scripts/update_swautomorph_submodules.sh` | Update git submodules |
| `scripts/openstack_build_opcp_explorer_env.sh`, `scripts/ovh_infrastructure.tf`, `scripts/cloud-init-script.yaml` | Infrastructure provisioning helpers (OpenStack / Terraform / cloud-init) |
| `recover_db.py` (repo root) | Standalone database recovery helper |

Test scripts (`scripts/test_*.py`, `tests/`) are described in [technicals/TESTING.md](./technicals/TESTING.md).
