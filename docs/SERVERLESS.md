# Serverless Jobs

OPCP-explorer lets an authenticated user run a short-lived container ("job"): an image, a command, optional environment variables and a timeout. Jobs are queued in PostgreSQL, executed in a hardened container, and their exit code and stdout/stderr are kept for retrieval.

Related docs: [API_REFERENCE.md](API_REFERENCE.md) · [SHARE_GPU_DOCKER.md](SHARE_GPU_DOCKER.md) (runtime / GPU) · [LIST_OF_APP_AVAILABLE.md](LIST_OF_APP_AVAILABLE.md) (`opcp-serverless-brik`) · [technicals/DATABASE.md](technicals/DATABASE.md)

---

## Components

| Component | Location | Role |
|-----------|----------|------|
| REST API | `src/routes/serverless_routes.py` (blueprint `serverless_bp`, prefix `/api`) | Submit, list, inspect, cancel jobs; list serverless endpoints; admin metrics |
| Job queue | PostgreSQL tables `serverless_jobs`, `serverless_job_logs`, `serverless_job_results` | Job state, output, structured result |
| Worker | `src/serverless/worker.py` (`python3 -m src.serverless.worker`) | Claims pending jobs, runs containers, stores output |
| Container runtime | `src/serverless/container_runtime.py` | Docker CLI wrapper (Podman fallback) with security flags |
| Config | `src/serverless/config.py` (`SERVERLESS_CONFIG`) | Registry whitelist, limits, timeouts |
| Log cleanup | `src/serverless/log_cleanup.py` | Purges logs/jobs older than 30 days |
| Serverless endpoints | `opcp-serverless-brik` application (see [LIST_OF_APP_AVAILABLE.md](LIST_OF_APP_AVAILABLE.md)) | Remote "brik" a job is targeted at (`target_link`) |
| UI | Dashboard tab **🚀 Serverless** (`orchestratorServerlessSection` in `templates/dashboard.html`, JS in `static/js/dashboard_functions.js`) | Endpoint list, metrics, submit form, job table |

```
 Dashboard / API client
        │ POST /api/jobs (image, command, env, timeout, target_link)
        ▼
 ┌──────────────────┐   INSERT status=pending   ┌──────────────────────┐
 │ serverless_bp    │──────────────────────────▶│ serverless_jobs (PG) │
 │ (Flask, /api)    │◀──── read status/logs ────│ + job_logs / results │
 └───────┬──────────┘                           └──────────▲───────────┘
         │ GET {target_link}/jobs/<id>                     │ SELECT … FOR UPDATE SKIP LOCKED
         ▼ (status sync, see below)                        │ UPDATE status / INSERT logs
 opcp-serverless-brik endpoint                  ┌──────────┴───────────┐
                                                │ serverless worker    │──▶ docker run (runc|kata)
                                                └──────────────────────┘
```

---

## Job lifecycle

Statuses (DB `CHECK` constraint): `pending`, `running`, `completed`, `failed`, `timeout`, `cancelled`.

```
pending ──▶ running ──▶ completed   (container exited; any exit code)
   │           ├──────▶ failed      (registry rejected, pull/start error, …)
   │           ├──────▶ timeout     (exceeded timeout_seconds)
   └───────────┴──────▶ cancelled   (POST /api/jobs/<id>/cancel)
```

1. **Submit** – `POST /api/jobs` validates the payload and inserts a `pending` row with the chosen `target_link`.
2. **Claim** – a worker selects the oldest `pending` job with `FOR UPDATE SKIP LOCKED`, sets `running`, `worker_id`, `started_at`.
3. **Execute** – the worker re-checks the registry whitelist, `docker pull`s the image, then `docker run -d` with the security flags below.
4. **Wait** – the worker waits in 2-second slices; between slices it checks whether the job was set to `cancelled` (then stops the container) and enforces the timeout.
5. **Store** – stdout and stderr go to `serverless_job_logs`; `{exit_code, stdout_length, stderr_length}` goes to `serverless_job_results`; status becomes `completed` with `exit_code` (a non-zero exit code is still `completed`).
6. **Failures** – any exception marks the job `failed` and writes the error message as a `stderr` log line. Timeout stops the container (`container_stop_timeout`, 10 s) and marks `timeout`. The container is always removed (`docker rm -f`).

### Remote status sync (`target_link`)

Every job carries a `target_link` (an `opcp-serverless-brik` URL from `/api/serverless-links`). The API does **not** push the job to that endpoint; it only polls it. When a job is read while still `pending`/`running` (`GET /api/jobs`, `GET /api/jobs/<id>`, `GET /api/jobs/<id>/result`), `sync_job_from_remote()`:

- requests `GET {target_link}/jobs/<job_id>` (5 s timeout), first over HTTP with the port decremented by one, then the original HTTPS URL;
- maps the remote status (`success`/`completed` → `completed`, `error`/`failed` → `failed`, `timeout`, `running`, `pending`, `cancelled`);
- on a terminal remote status, updates the local row (`status`, `exit_code`, `completed_at`) and stores remote `stdout`/`stderr` in `serverless_job_logs`; on `running`, sets `started_at`.

If the endpoint is unreachable, the local DB values are returned unchanged.

Notes:

- The local worker claims **any** `pending` job; it ignores `target_link`.
- The port allocation (`calculate_app_ports`) puts the HTTP port at HTTPS + 1, but the sync tries HTTPS − 1, so the HTTP attempt usually misses and the HTTPS URL is used.

---

## REST API

All endpoints require a logged-in session (`session['user_id']`), otherwise `401 {"error": "Authentication required"}`. Non-admins only see and act on their own jobs (`403 Access denied` otherwise). Admin status is read from `session['is_admin']`. The login flow does not currently set that key, so in practice every user, admins included, is treated as a non-admin here: only their own jobs are visible and `/api/jobs/metrics` returns `403`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/serverless-links` | Available serverless endpoints |
| POST | `/api/jobs` | Submit a job |
| GET | `/api/jobs` | List jobs (paginated) |
| GET | `/api/jobs/metrics` | Queue metrics (admin only) |
| GET | `/api/jobs/<job_id>` | Job status/metadata |
| GET | `/api/jobs/<job_id>/result` | Exit code, stdout, stderr |
| POST | `/api/jobs/<job_id>/cancel` | Cancel a pending/running job |

### `GET /api/serverless-links`

Lists `opcp-serverless%` applications from `user_applications` (joined with a `RUNNING` deployment; falls back to any assignment with an `https_port`; last resort `https://<DOMAIN>:6133` owned by `admin`). Each endpoint is `OCCUPIED` if a `pending`/`running` job targets it, otherwise `AVAILABLE` (`UNKNOWN` on query error).

```json
{
  "links": ["https://<DOMAIN>:6133"],
  "endpoints": [
    {"url": "https://<DOMAIN>:6133", "username": "admin", "app_name": "opcp-serverless-brik", "status": "AVAILABLE"}
  ]
}
```

### `POST /api/jobs`

| Field | Required | Type | Rules |
|-------|----------|------|-------|
| `image` | yes | string | Registry must be in the whitelist, else `403 Image registry is not approved` |
| `command` | yes | list | Non-empty JSON array (argv) |
| `target_link` | yes | string | Endpoint URL, normally from `/api/serverless-links` |
| `env` | no | object | Default `{}` |
| `timeout` | no | integer | 1–3600 seconds, default 300 |

```http
POST /api/jobs
Content-Type: application/json

{
  "image": "python:3.11-slim",
  "command": ["python", "-c", "print('hello')"],
  "env": {"MY_VAR": "value"},
  "timeout": 60,
  "target_link": "https://<DOMAIN>:6133"
}
```

Response `201`: `{"job_id": "<uuid>"}`. Validation errors return `400` with an `error` message; DB errors `500`.

### `GET /api/jobs`

Query parameters: `page` (default 1), `per_page` (default 20, clamped to 1–100), `status` (one of the six statuses, else `400`). Ordered by `created_at DESC`.

```json
{
  "jobs": [{"job_id": "…", "user_id": 1, "image": "…", "status": "completed",
            "created_at": "…Z", "started_at": "…Z", "completed_at": "…Z",
            "exit_code": 0, "worker_id": "worker-001", "target_link": "https://<DOMAIN>:6133"}],
  "total": 1, "page": 1, "per_page": 20, "pages": 1
}
```

### `GET /api/jobs/<job_id>`

Returns `job_id`, `status`, `image`, `created_at`, `started_at`, `completed_at`, `exit_code`, `worker_id`. `404` if unknown.

### `GET /api/jobs/<job_id>/result`

Returns `{"exit_code", "stdout", "stderr", "result"}`. `409 Job is still in progress` if the job is not terminal. Output comes from the remote endpoint when it answers (then `result` is `null`), otherwise from `serverless_job_logs` (concatenated per stream) and `serverless_job_results`.

### `POST /api/jobs/<job_id>/cancel`

Only `pending` or `running` jobs (`409 Job cannot be cancelled` otherwise). Sets `cancelled` + `completed_at`; a worker running the job notices within ~2 s and stops the container. Response: `{"message": "Job cancelled", "job_id": "…"}`.

### `GET /api/jobs/metrics` (admin)

```json
{"pending_count": 0, "running_count": 0, "failed_count": 0,
 "avg_execution_time": 1.23, "queue_depth": 0, "avg_startup_duration": 0.6}
```

`avg_execution_time` = mean `completed_at - started_at` of completed jobs; `avg_startup_duration` = mean `started_at - created_at` (seconds, `null` if no data).

---

## Container security

Flags added by `DockerRuntime.run_container()` for every job:

| Flag | Value |
|------|-------|
| `--runtime <type>` | Only when the runtime type is not `runc` (e.g. `kata`) |
| `--read-only` | Read-only root filesystem |
| `--user nobody` | Unprivileged user |
| `--cap-drop ALL` | No Linux capabilities |
| `--memory` | `default_memory_limit` (512m) |
| `--cpus` | `default_cpu_limit` (1) |
| `--network none` | No network |
| `--security-opt no-new-privileges` | No privilege escalation |
| `--pids-limit 256` | Process limit |

The image registry is checked at submission (API) and again in the worker. A reference without a registry host (`python:3.11`, `library/python`) counts as `docker.io`; the host part (port stripped) of `ghcr.io/org/app`, `registry.example.com:5000/app` or `localhost/...` is compared to the whitelist.

### Runtime type (`runc` / `kata`)

The worker reads the top-level `runtime_type` key from the `configuration` table **once at startup** (`resolve_runtime_type()`), sanitised by `_sanitize_runtime_type()` to `runc` or `kata` (anything else, or a DB error, gives `runc`). Admins change it in **Settings → Container Runtime Type**; restart the worker to apply. `kata` requires the Kata runtime registered in Docker (done by `init_pltf.sh`, see [SHARE_GPU_DOCKER.md](SHARE_GPU_DOCKER.md#container-runtime-runc--kata)).

---

## Configuration

Effective values come from `SERVERLESS_CONFIG` in `src/serverless/config.py`:

| Key | Default | Used by |
|-----|---------|---------|
| `registry_whitelist` | `docker.io`, `ghcr.io`, `registry.example.com` | API + worker |
| `default_timeout` | 300 s | API (when `timeout` omitted) |
| `max_timeout` | 3600 s | Not read; the API and DB `CHECK` hard-code 1–3600 |
| `default_memory_limit` | `512m` | Worker |
| `default_cpu_limit` | `1` | Worker |
| `poll_interval` | 0.5 s | Worker idle sleep |
| `container_stop_timeout` | 10 s | Worker (timeout stop) |
| `max_concurrent_jobs`, `log_retention_days`, `warm_pool_enabled`, `warm_pool_size` | 100, 30, false, 0 | Defined but not used by the code |

`conf/serverless.ini` mirrors these values with comments, but **no code reads it**: edit `src/serverless/config.py` to change behaviour.

Log retention is hard-coded to 30 days in `cleanup_old_logs()`: it deletes `serverless_job_logs` rows older than 30 days and terminal `serverless_jobs` whose `completed_at` is older than 30 days. The worker runs it at startup and then every 24 h.

---

## Worker

```bash
# Foreground (from the repo root)
python3 -m src.serverless.worker

# As a systemd service
sudo scripts/install_worker_service.sh          # copy unit, daemon-reload, enable
sudo scripts/install_worker_service.sh --start  # … and start it
systemctl status serverless-worker.service
```

The worker is not started by `start_app.sh` or `controller_cli.py`; install or launch it separately.

`systemd/serverless-worker.service` is a **static** unit: `User=psmc`, `WorkingDirectory=/home/ubuntu/agentic-ai-plateform`, `PYTHONPATH` set to the same path, `WORKER_ID=worker-001`, `Restart=always`. Edit it to match your install user and path before installing.

Environment variables:

| Variable | Default |
|----------|---------|
| `WORKER_ID` | `worker-<hostname>-<pid>` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` |
| `POSTGRES_DB` | `ai_swautomorph` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `swautomorph` / `swautomorph_password` |

Behaviour:

- Runtime detection: `docker` if `docker --version` works, else `podman`; exits if neither.
- Several workers can run in parallel (`SKIP LOCKED` prevents double claims); one worker runs one job at a time.
- `SIGTERM`/`SIGINT` stop the loop after the current job.
- Logs: `logs/serverless_worker.log` (rotating, 10 MB × 5) plus stdout. API logs: `logs/serverless_routes.log`.

---

## Database

Created at DB init from `migration/add_serverless_jobs.sql` and `migration/add_target_link_to_serverless_jobs.sql`:

| Table | Key columns |
|-------|-------------|
| `serverless_jobs` | `id` UUID, `user_id`, `image`, `command` JSONB, `environment` JSONB, `timeout_seconds` (1–3600), `status`, `created_at`, `started_at`, `completed_at`, `exit_code`, `worker_id`, `target_link` |
| `serverless_job_logs` | `job_id` (cascade), `stream` (`stdout`/`stderr`), `content`, `created_at` |
| `serverless_job_results` | `job_id` (PK, cascade), `result` JSONB |

---

## Dashboard (🚀 Serverless tab)

- **Endpoints panel** – table of `/api/serverless-links` with AVAILABLE / OCCUPIED badges; OCCUPIED endpoints are disabled in the target dropdown.
- **Metrics panel** – `/api/jobs/metrics` (admin only).
- **Submit form** – target endpoint, image, command, env JSON, timeout (1–3600). Each non-empty line of the command box becomes **one element** of the `command` argv array, not one shell command. For example, enter `python`, `-c`, `print(1)` on three lines; a single line `python -c "print(1)"` is used by the local worker as a single executable name.
- **Jobs table** – ID, image, target, status, created; actions to view result and cancel.
- While the tab is open, jobs, metrics and endpoints refresh every 5 s.

---

## GPU

Serverless jobs do not request GPUs: the worker never passes `--gpus`. MIG partitions managed by the platform (see [SHARE_GPU_DOCKER.md](SHARE_GPU_DOCKER.md)) are not attached to serverless jobs.
