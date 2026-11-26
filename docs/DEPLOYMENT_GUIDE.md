# Deployment Guide

This guide covers installing and operating the OPCP-explorer control plane, and deploying applications onto it.

- New server? Start with [INIT_PLATFORM.md](./INIT_PLATFORM.md) (`init_pltf.sh` bootstrap). Then come back here.
- Every command is listed in [CLI_REFERENCE.md](./CLI_REFERENCE.md). Every endpoint is listed in [API_REFERENCE.md](./API_REFERENCE.md).

---

## 1. Requirements

| Item | Notes |
|------|-------|
| OS | Ubuntu 22.04+ with `sudo` |
| Python | 3.10+ with `venv` (dependencies in `requirements.txt`) |
| PostgreSQL | Installed and initialised by `start locally` (`setup_postgresql_database`) |
| Nginx | Installed with ModSecurity + OWASP CRS by `start locally` |
| Docker | Needed for user applications, serverless jobs and `docker` mode |
| Gitea | Optional, set up by `start locally` (non-blocking if it fails) |
| Ports | 80, 443, 3000 (Gitea) and 53 opened in `ufw`. Gunicorn listens on `127.0.0.1:5000`. |

---

## 2. Configuration

### `conf/deploy.ini`

`conf/deploy.ini` is **not** tracked in git. Create it from the template:

```bash
cp conf/deploy.ini.template conf/deploy.ini
```

| Key | Default | Used for |
|-----|---------|----------|
| `DOMAIN` | `agentic-ai-plateform.com` | nginx `server_name`, application URLs, SSL folder `ssl/<DOMAIN>/` |
| `PLTF_NAME` | `agentic-ai-plateform` | Display name (UI, banners) |
| `PLTF_FOLDER` | `agentic-ai-plateform` | Install folder `/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>`, container name prefix |
| `VERSION` | `0.0.1` | Shown by `version` and in the UI |
| `REPO_URL`, `SUBMODULE_URL` | GitHub URLs | Sources used by `init_pltf.sh` (the `shared` submodule holds `deployApp.sh` and the AI context files) |
| `RANGE_PORTS_PER_APPLICATION` | `12` | Ports reserved per application (6 HTTP + 6 HTTPS) |
| `LINUX_USER_INSTALLATION` | `psmc` | Linux user owning `/home/<user>/<PLTF_FOLDER>` and `/home/<user>/deployments` |
| `SECONDARY_DOMAINS` | *(empty)* | Extra nginx server blocks (`domain:server_names:proxy_pass,...`). See [technicals/NGINX_AND_DOMAINS.md](./technicals/NGINX_AND_DOMAINS.md). |
| `S3_BUCKET_NAME` | `opcp-s3` | Bucket for database backups |

`deployControlPlan.sh` exports every `KEY=value` line as an environment variable, so these optional keys can also be set in the file:

| Optional key | Default |
|--------------|---------|
| `EMAIL` | `admin@agentic-ai-plateform.com` |
| `DEFAULT_USER_ID` / `DEFAULT_USER_NAME` / `DEFAULT_USER_EMAIL` / `DEFAULT_DESCRIPTION` | `0` / `admin` / `admin@softfluid.fr` / `Basic Admin user for Control Plan` |
| `GITEA_VERSION` / `GITEA_ADMIN_USER` / `GITEA_ADMIN_PASSWORD` / `GITEA_ADMIN_EMAIL` / `GITEA_PORT` | `1.21.3` / `gitadmin` / `password` / … / `3000` |
| `FLASK_PORT` | `5000` |
| `MODSECURITY_CONF_DIR` / `MODSECURITY_RULES_DIR` / `OWASP_CRS_VERSION` | `/etc/nginx/modsec` / `/usr/share/modsecurity-crs` / `v3.3.5` |
| `PG_VERSION` | `18` |
| `RANGE_START` / `RANGE_RESERVED` | `6000` / `100` (base of the per-application port range, see `src/database_postgres.py`) |
| `RANGE_START_CONTROLPLAN` / `RANGE_RESERVED_CONTROLPLAN` | `80` / `0` |

> Change `GITEA_ADMIN_PASSWORD` before the first `start`.

### `.env`

`start` generates `.env` on the first run. It contains a random `SECRET_KEY`, the `POSTGRES_*` connection settings and `USE_POSTGRES=true`. The Flask app (`python-dotenv`) and `controller_cli.py` both read it. Other settings read from the environment:

| Variable | Purpose |
|----------|---------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_MIN_CONN`, `POSTGRES_MAX_CONN`, `POSTGRES_SSLMODE`, `POSTGRES_TIMEOUT` | Database connection and pool |
| `SECRET_KEY` | Flask session signing. **Must** be set in production. |
| `SYNC_SECRET` | Shared secret between replicating servers. Default `default-sync-secret-change-me`. Change it. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | Email for password reset and email 2FA |

### Other configuration files

| File | Purpose |
|------|---------|
| `conf/default_apps` | Applications inserted into the catalog when the database is first built (see [LIST_OF_APP_AVAILABLE.md](./LIST_OF_APP_AVAILABLE.md)) |
| `conf/serverless.ini` | Documented serverless settings (registry whitelist, limits, timeouts). Not read by code yet; the effective values are in `src/serverless/config.py`. See [SERVERLESS.md](./SERVERLESS.md). |
| `gunicorn.conf.py` | Gunicorn bind (`127.0.0.1:5000`), workers (`2 × CPU + 1`), 30-min timeout for AI operations |

### SSL certificates

nginx loads the certificate and key from:

```
ssl/<DOMAIN>/fullchain_domain.crt
ssl/<DOMAIN>/privateKey_domain.key
```

Put your certificate files at these paths. `scripts/generate_ssl.sh` (self-signed) writes to `ssl/`, and `scripts/setup_letsencrypt.sh` writes `ssl/cert.pem`/`ssl/key.pem` for a hardcoded domain. Neither script writes to `ssl/<DOMAIN>/`, so copy or rename their output, or edit the scripts, before you rely on them. The SSL step of the setup wizard (`/api/wizard/ssl/*`) can also generate or upload certificates.

---

## 3. Start the platform

```bash
cd /home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>
source .venv/bin/activate
python3 scripts/controller_cli.py start locally     # production, on the host
# or
python3 scripts/controller_cli.py start docker      # docker-compose stack
# or
python3 scripts/controller_cli.py start             # pick the mode from a menu
```

`start locally` runs these steps, in order:

1. Validates the user id and checks requirements (Python, nginx + ModSecurity, PostgreSQL).
2. Creates `data/`, `ssl/`, `logs/`, `softfluid/db/`, generates SSL if missing, and writes `.env`.
3. Installs Python dependencies, then sets up Gitea (failure is non-blocking).
4. Initialises PostgreSQL and starts Gunicorn (`wsgi:application`, PID in `conf/app.pid`).
5. Writes the nginx site config (main domain + secondary domains, ModSecurity) and reloads nginx.
6. Opens the firewall (80/443/3000/53).
7. Syncs the per-application nginx locations from the database.
8. Installs an hourly `--backup_db` cron job.

Once running, the platform is available at:

| What | URL |
|------|-----|
| Dashboard | `https://<DOMAIN>/` |
| REST API | `https://<DOMAIN>/api/...` |
| Gitea | `https://<DOMAIN>/gitea` (port 3000) |
| Docs | `https://<DOMAIN>/docs`, user guide at `/userguide` |
| User applications | `https://<DOMAIN>/<user>/<application>` |

The built-in **`admin`** user is the super admin. It can grant admin rights to other users from the Users tab (see [USER_GUIDE.md](./USER_GUIDE.md)).

### Docker mode

`start docker` uses `docker-compose.yml`. It runs three services:

- `postgres`: postgres:15-alpine, initialised with `scripts/postgresql_schema.sql`.
- `app`: built from `Dockerfile`.
- `nginx`.

Container names are prefixed with `PLTF_FOLDER`. App ports default to 6000–6011 (`HTTP_PORT*`/`HTTPS_PORT*`). Docker mode is intended for development and testing.

### Manual start (development)

```bash
pip install -r requirements.txt
python3 scripts/controller_cli.py init-db
python3 ControlPlanFlaskApp.py                       # Flask dev server (src/main.py)
# or, production-like:
gunicorn -c gunicorn.conf.py wsgi:application
```

---

## 4. Day-to-day operations

```bash
python3 scripts/controller_cli.py ps                 # service status
python3 scripts/controller_cli.py logs               # recent logs
python3 scripts/controller_cli.py restart locally    # restart app + reload nginx
python3 scripts/controller_cli.py stop locally --app-only   # maintenance: user apps stay online
python3 scripts/controller_cli.py stop locally --stop-all   # full stop
python3 scripts/controller_cli.py upgrade            # pull latest code (then restart)
python3 scripts/controller_cli.py backup-db          # manual backup (also runs hourly)
python3 scripts/controller_cli.py recover-db         # interactive restore (local or S3)
python3 scripts/controller_cli.py update-nginx-locations
```

Logs are written to `logs/`. This includes the Gunicorn logs and `logs/print_output_swautomorph.log` (stdout of the app).

Backups go to `softfluid/db/backup/<timestamp>/` and are synced to S3 with the `OVH-SWAUTOMORPH` AWS profile. See [technicals/BACKUP_AND_RECOVERY.md](./technicals/BACKUP_AND_RECOVERY.md).

### Run as a systemd service

```bash
sudo python3 scripts/controller_cli.py install-as-systemctl-service
sudo systemctl start opcp-explorer-controlplan
sudo systemctl status opcp-explorer-controlplan
```

> **Check before enabling:** the generated unit's `ExecStart`/`ExecStop` point to `scripts/start_*_controlplan.sh` / `scripts/stop_*_controlplan.sh`. In the current tree these scripts are named `start_cloudstore_docker_ai_controlplan.sh` / `stop_cloudstore_docker_ai_controlplan.sh`, and they `cd` into `/home/ubuntu/<PLTF_FOLDER>`. Align the names and paths with your install before you rely on the unit.

The serverless worker has its own unit (`systemd/serverless-worker.service`, installed with `scripts/install_worker_service.sh`). See [SERVERLESS.md](./SERVERLESS.md).

---

## 5. Deploying applications

An *application* is a git repository that follows the `deployApp.sh` contract from the `shared` submodule. A *deployment* is one user's instance of that application. The platform supports three ways to run a workload:

| Way | Best for | Doc |
|-----|----------|-----|
| Git application (catalog app → clone → start) | Long-running web apps owned by a user | below |
| Deploy template (Docker image blueprint) | One-click static site, FastAPI, n8n, Ollama, Jupyter, Qdrant | [LIST_OF_APP_AVAILABLE.md](./LIST_OF_APP_AVAILABLE.md) |
| Serverless job | Short-lived container jobs | [SERVERLESS.md](./SERVERLESS.md) |
| Orchestrator service | Replicated containers with reconciliation | [technicals/ORCHESTRATOR.md](./technicals/ORCHESTRATOR.md) |

### Git application lifecycle

1. **Catalog.** Admins add applications in *Applications Management* (or `POST /api/applications`, or `controller_cli.py add-app`). Defaults come from `conf/default_apps`.
2. **Assign.** The user adds the application to *My Applications*. The platform allocates 12 consecutive ports for that user/app pair (`calculate_app_ports` in `src/database_postgres.py`).
3. **Clone.** The repository is cloned with `--recurse-submodules` into `/home/<LINUX_USER_INSTALLATION>/deployments/<user>/<application>`.
4. **Operate.** START / STOP / RESTART / PS / LOGS run the app's `deployApp.sh` with the user's context. You can trigger them from the dashboard, from `POST /api/deployments` (with `"stream": true` for Server-Sent Events) or through the AI Operations agent.
5. **Expose.** nginx gets a location block for the app, which is then reachable at `https://<DOMAIN>/<user>/<application>`.

Example:

```bash
curl -X POST https://<DOMAIN>/api/deployments \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"application_name":"ai-staticwebsite","action":"start","stream":true}'
```

### Container runtime (runc / kata)

Admins pick the container runtime in **Settings**:

- `runc` (default) adds no extra flag.
- `kata` adds `--runtime kata` to orchestrator containers and serverless jobs. For git applications it is passed to `deployApp.sh`, both as a trailing positional argument and as the `RUNTIME_TYPE` environment variable. A `deployApp.sh` honours it with:

```bash
docker run --runtime "${RUNTIME_TYPE:-runc}" ...
```

Any value other than `runc`/`kata` falls back to `runc`. The serverless worker reads the runtime type at startup, so restart it after a change. Kata must be registered with Docker (`init_pltf.sh` does this). Check with `docker info | grep -i kata`.

### Multi-server

Servers are registered in *Server Management* (`/api/servers`). `POST /api/server/allocate` picks a server by capacity. Data replicates between peers; see [technicals/REPLICATION.md](./technicals/REPLICATION.md).

---

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| App not reachable | `controller_cli.py ps`, `logs`. Port conflicts: `sudo ss -tulpn \| grep -E ':(80\|443\|3000\|5000)'` |
| Gunicorn already running / stale PID | `scripts/kill_flask.sh`, then `restart locally` |
| User app 404 under `/<user>/<app>` | `controller_cli.py update-nginx-locations`, then `sudo nginx -t` |
| DB connection errors | `.env` `POSTGRES_*`, `controller_cli.py db-health`, `db-status --show-env` |
| Permission errors in deployments | `sudo chown -R <user>:<user> /home/<user>/deployments /home/<user>/<PLTF_FOLDER>` |
| SSL errors | Files present in `ssl/<DOMAIN>/`, `sudo nginx -t` |
| Kata containers fail | `docker info` lists `kata` under Runtimes, `docker run --runtime kata --rm hello-world` |

### Full reset (destructive)

```bash
python3 scripts/controller_cli.py stop locally --stop-all
python3 scripts/controller_cli.py delete-db          # asks for confirmation
python3 scripts/controller_cli.py start locally
```

For docker mode: `docker compose down -v`.
