# Platform Overview

OPCP-explorer is a self-hosted control plane for deploying and operating applications, containers and GPU workloads on bare-metal or cloud servers. Humans and GenAI agents use it through the same four interfaces: the web dashboard, the REST API, the CLI and MCP. The display name is configurable (`PLTF_NAME` in `conf/deploy.ini`).

## Capabilities

| Area | What you get |
|------|--------------|
| Application lifecycle | Catalog of git applications, per-user deployments (clone / start / stop / restart / ps / logs), live logs over Server-Sent Events, 12 reserved ports per application |
| Deploy templates | One-click blueprints shared by the dashboard, CLI, MCP and REST: static site, FastAPI, n8n, Ollama, Jupyter, Qdrant |
| Serverless | On-demand Docker jobs from a PostgreSQL-backed queue, run by worker processes with registry whitelist, limits and timeouts |
| Shared GPU | NVIDIA MIG partitioning per server (up to 7 instances) from the UI or API |
| Container isolation | `runc` by default, or Kata Containers MicroVMs (`kata`) selectable by admins |
| App Orchestrator | Replicated container services with health checks and a reconciliation loop |
| Networking | Automatic nginx reverse-proxy locations `https://<DOMAIN>/<user>/<app>`, secondary domains, ModSecurity WAF (OWASP CRS) |
| Multi-server | Server registry with capacity-based allocation, discovery, primary/secondary roles and peer-to-peer database replication |
| AI agents | Virtual Developer (code changes on a git branch) and Virtual Operations (lifecycle actions), powered by Kiro CLI or OVH `shai` |
| Identity & security | Registration, sessions, SSO tokens, TOTP / email 2FA, password reset. Super admin `admin` can grant admin rights to other users. |
| Billing | Activity-based cost tracking, monthly invoices, PDF export |
| Onboarding | Setup wizard API that safely writes `conf/deploy.ini`, a labelled sandbox demo account |
| Operations | PostgreSQL with connection pooling, hourly backups with S3 sync, interactive recovery, systemd integration |

## Architecture at a glance

```
 Web dashboard  |  REST API  |  CLI (controller_cli.py)  |  MCP (mcp_server.py)
                              │
             nginx + ModSecurity (TLS, /<user>/<app> locations)
                              │
         Flask app (Gunicorn) – blueprints in src/routes/
                              │
 Orchestrator · Serverless workers · GPU/MIG manager · Replication worker · AI agents
                              │
     PostgreSQL · Docker (runc / kata) · Gitea · S3 (backups) · peer servers
```

Details: [ARCHITECTURE_GUIDE.md](./ARCHITECTURE_GUIDE.md).

## Interfaces

| Interface | Use case | Reference |
|-----------|----------|-----------|
| Web dashboard | Users, operators and admins | [USER_GUIDE.md](./USER_GUIDE.md) |
| REST API | Automation, CI/CD, agents | [API_REFERENCE.md](./API_REFERENCE.md) |
| CLI | Platform operations and scripting | [CLI_REFERENCE.md](./CLI_REFERENCE.md) |
| MCP | GenAI agents (`list_applications`, `add_application`, `get_user_info`, `list_users`, `deploy_template`) | `scripts/mcp_server.py` |

## Configuration at a glance

- `conf/deploy.ini` (created from `conf/deploy.ini.template`): domain, platform identity, install user, port range, secondary domains, S3 bucket.
- `.env`: `SECRET_KEY`, `POSTGRES_*`, plus optional `SYNC_SECRET` and `SMTP_*`. Generated on the first `start`.
- `conf/default_apps`: the application catalog seeded on first database build.
- `conf/serverless.ini`: documented serverless settings. It is not read by code yet; the effective values are in `src/serverless/config.py`.

## Documentation map

| Doc | Topic |
|-----|-------|
| [INIT_PLATFORM.md](./INIT_PLATFORM.md) | Bootstrapping a server with `init_pltf.sh` |
| [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) | Configuring, starting and operating the platform; deploying applications |
| [USER_GUIDE.md](./USER_GUIDE.md) | Using the dashboard |
| [ARCHITECTURE_GUIDE.md](./ARCHITECTURE_GUIDE.md) | Components, data model, flows |
| [CLI_REFERENCE.md](./CLI_REFERENCE.md) / [API_REFERENCE.md](./API_REFERENCE.md) | Command and endpoint references |
| [SERVERLESS.md](./SERVERLESS.md) | Serverless Docker execution |
| [SHARE_GPU_DOCKER.md](./SHARE_GPU_DOCKER.md) | MIG shared GPU |
| [LIST_OF_APP_AVAILABLE.md](./LIST_OF_APP_AVAILABLE.md) | Default applications and deploy templates |
| `docs/technicals/` | Deep dives: `REPLICATION.md`, `NGINX_AND_DOMAINS.md`, `BACKUP_AND_RECOVERY.md`, `ORCHESTRATOR.md`, `DATABASE.md`, `VIRTUAL_AGENTS.md`, `TESTING.md` |
