# OPCP-explorer

OPCP-explorer is a self-hosted control plane for deploying and operating applications, containers and GPU workloads. GenAI agents and humans drive it through the same four interfaces: a **web dashboard**, a **REST API**, a **CLI** and **MCP**.

The platform display name is configurable (`PLTF_NAME` in `conf/deploy.ini`, default `agentic-ai-plateform`).

## Features

- **Application lifecycle**: git-based application catalog, per-user deployments (clone, start, stop, restart, status, logs), live logs over Server-Sent Events, 12 reserved ports per application.
- **Deploy templates**: one-click blueprints for a static site, FastAPI, n8n, Ollama, Jupyter and Qdrant, identical across dashboard, CLI, MCP and REST.
- **Serverless Docker jobs**: PostgreSQL-backed queue, worker service, registry whitelist, resource limits and timeouts.
- **MIG shared GPU**: partition NVIDIA H100/A100/A30 GPUs per server from the UI or API.
- **Container isolation**: `runc` by default, or Kata Containers MicroVMs (`kata`).
- **App Orchestrator**: replicated container services with health checks and reconciliation.
- **Networking**: automatic nginx locations `https://<DOMAIN>/<user>/<app>`, secondary domains, ModSecurity WAF with OWASP CRS.
- **Multi-server**: capacity-based allocation, server discovery, primary/secondary roles and peer-to-peer database replication.
- **AI agents**: Virtual Developer and Virtual Operations, powered by Kiro CLI or OVH `shai`.
- **Security**: sessions, SSO tokens, TOTP/email 2FA, password reset. The built-in `admin` super admin can grant admin rights to other users.
- **Billing**: activity-based costs, monthly invoices, PDF export.
- **Operations**: PostgreSQL with pooling, hourly backups synced to S3, interactive recovery, systemd unit, EN/FR UI.

## Quick start

```bash
# 1. Bootstrap a fresh Ubuntu server (Docker, Kata, NVIDIA/MIG, CLIs, clone, venv)
cp conf/deploy.ini.template conf/deploy.ini && vi conf/deploy.ini
./init_pltf.sh

# 2. In the cloned folder: complete conf/deploy.ini and add ssl/<DOMAIN>/ certificates,
#    then start everything (PostgreSQL, Gunicorn, nginx + ModSecurity, Gitea, backups cron)
cd <INSTALL_DIR>/<PLTF_FOLDER>
source .venv/bin/activate
python3 scripts/controller_cli.py start locally

# 3. Check
python3 scripts/controller_cli.py ps
```

Open `https://<DOMAIN>/` and log in. For a development setup without the full stack:

```bash
pip install -r requirements.txt
python3 scripts/controller_cli.py init-db
python3 ControlPlanFlaskApp.py                   # or: gunicorn -c gunicorn.conf.py wsgi:application
```

## Everyday commands

`scripts/controller_cli.py` is the single entry point. Its lifecycle commands wrap `deployControlPlan.sh`, which you can still call directly.

```bash
python3 scripts/controller_cli.py start|stop|restart [locally|docker]
python3 scripts/controller_cli.py stop locally --app-only    # keep nginx + user apps online
python3 scripts/controller_cli.py ps | logs | upgrade | version
python3 scripts/controller_cli.py backup-db | recover-db
python3 scripts/controller_cli.py db-health | list-tables | describe-table users
python3 scripts/controller_cli.py update-nginx-locations
python3 scripts/controller_cli.py templates list
python3 scripts/controller_cli.py templates deploy fastapi-starter my-api --user-id 2
python3 scripts/controller_cli.py sandbox provision|reset|teardown
sudo python3 scripts/controller_cli.py install-as-systemctl-service
```

Full list: [docs/CLI_REFERENCE.md](docs/CLI_REFERENCE.md).

## API in 30 seconds

The API uses a session cookie obtained by logging in.

```bash
# Look up a user id (public)
curl "https://<DOMAIN>/api/users/id?username=alice"

# Start an application and stream its output
curl -X POST https://<DOMAIN>/api/deployments -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"application_name":"ai-staticwebsite","action":"start","stream":true}'

# Deploy a template
curl -X POST https://<DOMAIN>/api/templates/fastapi-starter/deploy -b cookies.txt \
  -H "Content-Type: application/json" -d '{"application_name":"my-api"}'

# Submit a serverless job
curl -X POST https://<DOMAIN>/api/jobs -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"image":"python:3.11","command":["python","-c","print(42)"],"timeout":60}'
```

Every endpoint: [docs/API_REFERENCE.md](docs/API_REFERENCE.md). MCP server for agents: `python3 scripts/mcp_server.py`.

## Configuration

| File | Purpose |
|------|---------|
| `conf/deploy.ini` (from `conf/deploy.ini.template`, not tracked in git) | `DOMAIN`, `PLTF_NAME`, `PLTF_FOLDER`, `VERSION`, `REPO_URL`, `SUBMODULE_URL`, `RANGE_PORTS_PER_APPLICATION`, `LINUX_USER_INSTALLATION`, `SECONDARY_DOMAINS`, `S3_BUCKET_NAME` |
| `.env` (generated on the first `start`) | `SECRET_KEY`, `POSTGRES_*`. Optional: `SYNC_SECRET`, `SMTP_*`. |
| `conf/default_apps` | Application catalog seeded on the first database build |
| `conf/serverless.ini` | Documented serverless settings. Not read by code yet; the effective values are in `src/serverless/config.py`. |
| `ssl/<DOMAIN>/` | `fullchain_domain.crt`, `privateKey_domain.key` |

The install layout is `/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>`. User deployments live in `/home/<LINUX_USER_INSTALLATION>/deployments/<user>/<app>`.

## Repository layout

```
src/                     Flask application
  ControlPlanFlaskApp_postgres.py   app factory (registers all blueprints)
  routes/                main, auth, sso, api, genai, billing, orchestrator, replication,
                         security, serverless, gpu, templates, wizard, sandbox
  serverless/            worker, container runtime, config, log cleanup
  wizard/                setup wizard + SSL configurator
  database_postgres.py   pooled PostgreSQL manager, init_db, port allocation
  config_postgres.py     configuration + EN/FR translations
  admin_auth.py          admin / super-admin rules
  nginx_manager.py  orchestrator.py  replication_manager.py  template_*.py  sandbox_manager.py ...
scripts/                 controller_cli.py, orchestrator_cli.py, mcp_server.py, helpers, test_*.py,
                         postgresql_schema.sql
migration/               incremental SQL migrations
conf/                    deploy.ini.template, default_apps, serverless.ini
templates/ static/       dashboard UI (Jinja2 + JS)
tests/                   pytest (tests/*.py), bash (tests/bash), JS (tests/js)
systemd/                 serverless worker unit
docs/                    documentation (also served in-app at /docs)
init_pltf.sh             server bootstrap
deployControlPlan.sh     deployment engine used by controller_cli.py
wsgi.py, gunicorn.conf.py, ControlPlanFlaskApp.py, Dockerfile, docker-compose.yml
```

## Documentation

| Doc | Topic |
|-----|-------|
| [Platform overview](docs/PLATFORM_OVERVIEW.md) | What the platform does |
| [Init platform](docs/INIT_PLATFORM.md) | Server bootstrap with `init_pltf.sh` |
| [Deployment guide](docs/DEPLOYMENT_GUIDE.md) | Configure, start, operate; deploy applications |
| [User guide](docs/USER_GUIDE.md) | Using the dashboard |
| [Architecture guide](docs/ARCHITECTURE_GUIDE.md) | Components, data model, flows |
| [CLI reference](docs/CLI_REFERENCE.md) · [API reference](docs/API_REFERENCE.md) | Commands and endpoints |
| [Serverless](docs/SERVERLESS.md) · [Shared GPU](docs/SHARE_GPU_DOCKER.md) · [Apps & templates](docs/LIST_OF_APP_AVAILABLE.md) | Feature guides |
| [Replication](docs/technicals/REPLICATION.md) · [Nginx & domains](docs/technicals/NGINX_AND_DOMAINS.md) · [Backup & recovery](docs/technicals/BACKUP_AND_RECOVERY.md) · [Orchestrator](docs/technicals/ORCHESTRATOR.md) · [Database](docs/technicals/DATABASE.md) · [AI agents](docs/technicals/VIRTUAL_AGENTS.md) · [Testing](docs/technicals/TESTING.md) | Technical deep dives |

## Troubleshooting

```bash
python3 scripts/controller_cli.py ps                       # what is running
python3 scripts/controller_cli.py logs                     # recent logs (also see logs/)
python3 scripts/controller_cli.py db-health                # database
python3 scripts/controller_cli.py update-nginx-locations   # user app 404s
sudo nginx -t                                              # nginx config
scripts/kill_flask.sh                                      # stray Gunicorn processes
```

More: [Deployment guide, troubleshooting section](docs/DEPLOYMENT_GUIDE.md#6-troubleshooting).
