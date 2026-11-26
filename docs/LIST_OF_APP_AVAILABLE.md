# Available Applications and Deploy Templates

OPCP-explorer offers two kinds of deployable content:

1. **Default applications**: Git repositories listed in `conf/default_apps`, loaded into the `applications` table at DB init and deployed with the git-based deploy flow (clone, build, start).
2. **Deploy templates**: ready-made container blueprints (Docker image + ports + env + resource hints) stored in `deploy_templates` and deployed through the light orchestrator. They appear in the **🛒 Marketplace** tab, the CLI, the MCP server and the REST API.

Related docs: [USER_GUIDE.md](USER_GUIDE.md) · [CLI_REFERENCE.md](CLI_REFERENCE.md) · [API_REFERENCE.md](API_REFERENCE.md) · [SERVERLESS.md](SERVERLESS.md) · [technicals/ORCHESTRATOR.md](technicals/ORCHESTRATOR.md) · [technicals/NGINX_AND_DOMAINS.md](technicals/NGINX_AND_DOMAINS.md)

---

## 1. Default applications (`conf/default_apps`)

| # | Name | Description | Repository |
|---|------|-------------|------------|
| 1 | `ai-staticwebsite` | Simple static Web Site | https://github.com/Sam9682/ai-staticwebsite.git |
| 2 | `ai-shai-web-interface` | Interface Web pour Shai | https://github.com/Sam9682/ai-shai-web-interface.git |
| 3 | `opcp-openstack-first-steps` | OPCP Openstack First Steps | https://github.com/Sam9682/opcp-openstack-first-steps.git |
| 4 | `opcp-openstack-automation` | OPCP Openstack Automation | https://github.com/Sam9682/opcp-openstack-automation.git |
| 5 | `opcp-psmc-dashboard` | OPCP PSMC Dashboard | https://github.com/Sam9682/opcp-psmc-dashboard.git |
| 6 | `opcp-openstack-simulator` | OPCP Openstack Simulator | https://github.com/Sam9682/opcp-openstack-simulator.git |
| 7 | `opcp-introduction` | OPCP Introduction - non tech | https://github.com/Sam9682/opcp-introduction.git |
| 8 | `opcp-serverless-brik` | OPCP Serverless Docker Execution | https://github.com/Sam9682/opcp-serverless-brik.git |
| 9 | `opcp-ai-start-labs` | OPCP AI Start Labs | https://github.com/Sam9682/opcp-ai-start-labs.git |
| 10 | `opcp-proxmox-experience` | OPCP Proxmox experience | https://github.com/Sam9682/opcp-proxmox-experience.git |
| 11 | `opcp-internal-rag` | OPCP Internal PSMC RAG | https://github.com/Sam9682/opcp-internal-rag.git |

All entries declare a repo size of 10 MB and timings of build 30 s / start 30 s / stop 10 s / ps 1 s, except `ai-staticwebsite` (4 MB, build 29 s, start 29 s).

### File format

One application per line, 8 pipe-separated fields (whitespace around fields is trimmed). Lines starting with `#` and blank lines are ignored.

```
name | description | git_url | git_repo_size | docker_build_duration | docker_start_duration | docker_stop_duration | docker_ps_duration
```

The last five fields must be integers (repo size in MB, durations in seconds, used for progress estimates). A line that does not have exactly 8 fields is skipped with a warning. A non-integer value makes the loader stop and keep only the lines read so far.

### Loading at DB init (`src/database_postgres.py`)

During `init_db()`:

1. **`opcp-serverless-brik` is forced**, whatever `conf/default_apps` contains. If the application is missing it is inserted (description `agentic-ai-plateform Serverless Docker Execution`, cost 1.0/day). It is then assigned to **every existing user** (`user_applications` with 12 computed ports), and an `admin` deployment row with status `RUNNING` is created if none exists, so the brik shows up in `/api/serverless-links` (see [SERVERLESS.md](SERVERLESS.md)). This block commits on its own.
2. **`load_default_apps()`** parses `conf/default_apps` and inserts the rows with `ON CONFLICT (name) DO NOTHING` (idempotent; editing an existing line later does **not** update the DB row). Any application without a cost gets `cost_per_day = 1.0`. Committed in its own transaction.
3. If the `admin` user does not exist yet, `admin` and `demo` are created (password `password`), and all applications are assigned with computed ports and URL `https://www.<DOMAIN>:<https_port>`. The code intends this assignment for `admin`, but it uses the id returned by the *last* insert, so the apps go to `demo`. On a fresh database, step 1 runs before any user exists, so the brik assignment and the admin brik deployment only appear on the next `init_db()` run (next app start).

New users get all applications through `assign_default_apps_to_user()` when they are created via the API. Each assignment reserves 12 consecutive ports (6 HTTPS + 6 HTTP) computed by `calculate_app_ports(user_id, app_id)`.

To add a default application, append a line to `conf/default_apps` and restart the app (or re-run DB init). Admins can also add applications from the dashboard's application management.

---

## 2. Deploy templates (Marketplace)

### Built-in catalog

Seeded by `migration/add_deploy_templates.sql` (applied at DB init, `ON CONFLICT (template_id) DO NOTHING`):

| `template_id` | `app_type` | Display name | Image | Container port | Env | Memory | CPU | Timeout |
|---------------|-----------|--------------|-------|----------------|-----|--------|-----|---------|
| `static-site` | `static_site` | Static Website | `nginx:1.27-alpine` | 80 | – | 128 MB | 0.5 | 300 s |
| `fastapi-starter` | `fastapi` | FastAPI Application | `tiangolo/uvicorn-gunicorn-fastapi:python3.11` | 80 | `MODULE_NAME=app.main` | 512 MB | 1.0 | 300 s |
| `n8n` | `n8n` | n8n Workflow Automation | `n8nio/n8n:latest` | 5678 | `N8N_PORT=5678` | 1024 MB | 1.0 | 600 s |
| `ollama` | `ollama` | Ollama LLM Runtime | `ollama/ollama:latest` | 11434 | `OLLAMA_HOST=0.0.0.0` | 4096 MB | 2.0 | 1200 s |
| `jupyter` | `jupyter` | Jupyter Notebook | `jupyter/base-notebook:latest` | 8888 | `JUPYTER_ENABLE_LAB=yes` | 2048 MB | 1.0 | 600 s |
| `vector-db` | `vector_db` | Qdrant Vector Database | `qdrant/qdrant:latest` | 6333 | – | 1024 MB | 1.0 | 300 s |

The same migration adds `users.account_type` and `deployments.is_sandbox` (used by the sandbox / demo mode).

### Table `deploy_templates`

`template_id` (unique, ≤ 63 chars), `app_type`, `display_name`, `source_image` (image ref or Git URL), `ports` JSONB (`[{"container": 80, "protocol": "http"}]`), `environment` JSONB (`[{"name": "K", "value": "V"}]`), `memory_mb` (64–65536), `cpu_cores` (0.1–64), `timeout_seconds` (1–3600), `enabled`, `created_at`. To add a template, insert a row; to hide one, set `enabled = false`.

### Validation (`src/template_catalog.py`)

`TemplateCatalog().load()` reads enabled rows ordered by `template_id` and validates each:

- `source_image` non-empty;
- `ports`: at least one entry, each an integer (or `{"container": n}`) in 1–65535;
- `environment`: a list of `{name, value}` objects with a non-empty `name`;
- `memory_mb`: integer 64–65536; `cpu_cores`: 0.1–64.

Invalid rows are skipped and logged (`catalog.errors` keeps `(template_id, first_failing_field)`); they never break loading. An empty catalog reports the indicator `"no valid templates"`. The catalog is reloaded from the DB on every request.

### Deploy flow (`src/template_deploy.py`)

All surfaces call `TemplateDeployService.deploy(template_id, app_name, user_id, sandbox_label=False)`:

| Step | Action | Failure |
|------|--------|---------|
| 1 | Name check: 1–63 chars, `[a-z0-9-]` only | `400` `invalid_name` |
| 2 | `catalog.get(template_id)` | `404` `not_found` |
| 3 | Name not already used by this user (`deployments` or `user_applications`) | `409` `name_conflict` |
| 4 | Get or create the `applications` row (description "Deployed from template"), compute 12 ports, insert `user_applications` with URL `https://<DOMAIN>/<user_id>/<app_name>` | `502` `deploy_failed` |
| 5 | `orchestrator.create_service(name, image, user_id, ports, environment)`: each template container port is mapped to the next allocated HTTP host port | `502` `deploy_failed` |
| 6 | `nginx_manager.insert_location_block(...)` | `502` `deploy_failed` |
| 7 | Insert `deployments` row (`status='running'`, `is_sandbox`) | `502` `deploy_failed` |

**Rollback**: on any failure from step 4 onwards, the service deletes the `deployments` and `user_applications` rows for (user, application) in one transaction. It then calls `orchestrator.delete_service()` and `nginx_manager.remove_location_block()` on a best-effort basis. The global `applications` row is kept.

Resource hints (`memory_mb`, `cpu_cores`, `timeout_seconds`) are forwarded only if `create_service` accepts them. The current orchestrator signature does not, so they are not applied.

### Surfaces

**Dashboard: 🛒 Marketplace tab.** Lists `GET /api/templates` (identifier, type, ports, resources). Enter an application name next to a template and click **🚀 Deploy**. The result panel shows the access URL or the error message.

**REST API** (`src/routes/templates_routes.py`, session required, otherwise `401`):

```http
GET /api/templates
→ 200 {"templates": [{"identifier": "static-site", "app_type": "static_site",
                      "ports": [{"container": 80, "protocol": "http"}],
                      "memory_mb": 128, "cpu_cores": 0.5}, …]}

POST /api/templates/<template_id>/deploy
{"application_name": "my-site"}
→ 200 {"application_id": 42, "application_name": "my-site",
       "access_url": "https://<DOMAIN>/<user_id>/my-site",
       "template_id": "static-site", "ports": [ …12 ports… ]}
→ 400 / 404 / 409 / 502 {"error": "<localized message>"}
```

The deploy runs as the session user. Error messages are localized (EN/FR) from `TRANSLATIONS`.

**CLI** (`scripts/controller_cli.py`):

```bash
python3 scripts/controller_cli.py templates list
python3 scripts/controller_cli.py templates deploy <template_id> <app_name> --user-id <id>
```

`templates deploy` with an unknown id prints the available identifiers and exits 1 without deploying. On success it prints the application id and access URL.

**MCP** (`scripts/mcp_server.py`): tool `deploy_template` with required `template_id`, `application_name` and `user_id`. It returns `{application_id, access_url, template_id}` on success, or `{error, error_code?, template_id}` on failure. There is no MCP tool to list templates.

**Sandbox / demo mode** (`src/sandbox_manager.py`): seeds demo applications through the same service with `sandbox_label=True`, which marks the rows `is_sandbox = true`.
