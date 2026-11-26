# Database (PostgreSQL)

OPCP-explorer stores all of its platform state in a single PostgreSQL database. The default database name is `ai_swautomorph` and the default role is `swautomorph`; both names are kept from the project's earlier name. The platform used SQLite before the move to PostgreSQL. The SQLite migration tooling has since been removed, and only a few SQLite-era leftovers remain (see §8).

Related docs: [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) · [REPLICATION.md](REPLICATION.md) · [ORCHESTRATOR.md](ORCHESTRATOR.md) · [../CLI_REFERENCE.md](../CLI_REFERENCE.md)

---

## 1. Connection settings

`get_database_config()` in `src/config_postgres.py` reads these environment variables. Locally they're usually loaded from `.env` by `wsgi.py` and `scripts/controller_cli.py`. `deployControlPlan.sh` writes a default `.env` when none exists.

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_HOST` | `localhost` | Server host (`postgres` inside docker-compose) |
| `POSTGRES_PORT` | `5432` | Port |
| `POSTGRES_DB` | `ai_swautomorph` | Database |
| `POSTGRES_USER` | `swautomorph` | Role |
| `POSTGRES_PASSWORD` | `swautomorph_password` | Password (change it) |
| `POSTGRES_MIN_CONN` / `POSTGRES_MAX_CONN` | `2` / `20` | Pool size |
| `POSTGRES_SSLMODE` | `prefer` | libpq `sslmode` |
| `POSTGRES_TIMEOUT` | `10` | `connect_timeout` (s) |

`USE_POSTGRES` still exists in a few modules. It defaults to `true`, except in `src/routes/sso_routes.py` where it defaults to `false`. PostgreSQL is the only supported backend.

---

## 2. Connection pooling (`src/database_postgres.py`)

- `PostgreSQLManager` is a thread-safe singleton, exposed as `db_manager`. It wraps a `psycopg2.pool.ThreadedConnectionPool` that's created lazily on first use. If creating it fails, it retries once with a 1–10 pool.
- `db_manager.get_db_connection()` is a context manager. It borrows a connection with `autocommit=False`. On an exception it rolls back and discards the connection.
- `db_manager.execute_query(query, params=None, fetch_one=False, fetch_all=False)`:
  - Passes the query through `convert_sqlite_to_postgres_query()` (from `src/query_converter.py`, which converts `?` placeholders to `%s`).
  - Commits, and retries up to 3 times with exponential backoff on `OperationalError`, `InterfaceError` or `DatabaseError`.
  - Returns the row, the rows, or `rowcount`.
  - After a successful `INSERT` or `UPDATE` on `users`, `servers`, `applications`, `user_applications`, `billing_activities` or `auth_tokens`, queues a replication event (see [REPLICATION.md](REPLICATION.md)).
- `db_manager.execute_many(query, params_list)` runs a batch inside one transaction.

---

## 3. Schema (`scripts/postgresql_schema.sql`)

| Table | Holds |
|---|---|
| `users` | Accounts, including `suspended`. The 2FA columns come from a migration, and `account_type` (`ADMIN` grants admin rights, see `src/admin_auth.py`) comes from the deploy templates migration. |
| `applications` | Application catalog (unique `name`, Git URLs, size and Docker timing metadata) |
| `auth_tokens` | SSO / auth tokens (hashed) |
| `user_applications` | Assigns applications to users; holds the user's URL and 12 port columns (`http_port…https_port6`) plus `others_port` |
| `servers` | Platform servers (`server_ip` INET unique, capacity, status, type) |
| `deployments` | Per-user app deployments: path, Git and Gitea URLs, `modification_history` and `backups_history` (JSONB) |
| `application_costs` | Cost per day per app |
| `billing_activities` | START/STOP activity for billing |
| `users_logs` | User activity log |
| `payment_modes`, `invoicing` | Billing |
| `configuration` | Key/value settings (`parent`, `key`, `value`), e.g. `agentic_engine`, `agentic_command`, `runtime_type` |
| `services`, `instances` | App Orchestrator (see [ORCHESTRATOR.md](ORCHESTRATOR.md)) |

The file also creates the `uuid-ossp` extension, the indexes (including a GIN index on `deployments.backups_history`) and an `update_updated_at_column()` trigger on `deployments`, `application_costs`, `services` and `instances`.

Tables added by migrations: `password_reset_tokens` and `twofa_email_codes` (2FA), `serverless_jobs`, `serverless_job_logs` and `serverless_job_results` (serverless), `mig_profiles` and `mig_instances` (MIG GPU), and `deploy_templates`.

---

## 4. Initialization and migrations

`init_db()` runs on every start, from `wsgi.py` and from `create_app()`. It also runs from `python3 scripts/controller_cli.py init-db`, which `deployControlPlan.sh` calls before starting Gunicorn. It is idempotent:

1. If the `users` table doesn't exist, it runs `scripts/postgresql_schema.sql`. In Docker mode the compose `postgres` service also mounts that file as `/docker-entrypoint-initdb.d/01-schema.sql`.
2. It applies these migrations on every run. Each one is wrapped in try/except, and errors from migrations that are already applied are only logged:

   | Applied automatically by `init_db` |
   |---|
   | `migration/add_password_reset_and_2fa.sql` |
   | `migration/add_serverless_jobs.sql` |
   | `migration/add_mig_gpu.sql` |
   | `migration/add_target_link_to_serverless_jobs.sql` |
   | `migration/make_application_fkeys_deferrable.sql` |
   | `migration/add_deploy_templates.sql` |
   | `migration/add_extended_ports_to_user_applications.sql` |

3. **Seeding:**
   - Ensures that `opcp-serverless-brik` exists and is assigned to every user, with an admin deployment row.
   - Inserts the applications from `conf/default_apps` with `ON CONFLICT DO NOTHING`, plus a default cost of 1.0/day.
   - Registers the current server if none exists.
   - Creates the `admin` and `demo` users (password `password`; change it) and a payment mode.
     ⚠️ Due to a bug, the "admin" id used for this step is read from the `demo` INSERT, so the initial app assignments and the payment mode go to `demo` rather than `admin`.
   - Fills in any missing ports in `user_applications`.
   - Adds the default `configuration` rows: `agentic_engine`, `agentic_command`, and `runtime_type=runc`.

**`init_db` does not apply** these files. Fresh installs don't need the first group, because the schema already contains those changes. Apply them by hand only when you upgrade an older database:

| File | Purpose | Needed on a fresh schema? |
|---|---|---|
| `add_backups_history_to_deployments.sql` | `deployments.backups_history` + GIN index | No (already in schema) |
| `add_url_to_applications.sql` | `applications.url` | No (already in schema) |
| `add_user_id_to_services.sql` | `services.user_id` + `UNIQUE(name,user_id)` | No (already in schema) |
| `fix_services_constraint.sql` | Same unique-constraint change | No |
| `fix_instances_fkey.sql` | Adds `instances.user_id` + FKs | Optional; the code doesn't use it |
| `fix_server_capacity.sql` | Sets NULL `server_capacity_appli_max` to 100 and NULL `server_capacity_user_max` to 20 | Data fix |
| `fix_deployment_user_id.sql` | Fixes deployments created under admin's id when cloning for other users (also see `scripts/fix_deployment_user_id.py`) | Data fix |

```bash
PGPASSWORD=... psql -h localhost -U swautomorph -d ai_swautomorph -f migration/<file>.sql
```

---

## 5. Port allocation (`calculate_app_ports`)

Each (user, application) pair gets **12 consecutive ports**, 6 HTTPS and 6 HTTP, laid out the same way as `calculate_ports` in the apps' `deployApp.sh`:

```
base = RANGE_START + user_id * RANGE_RESERVED + app_id * RANGE_PORTS_PER_APPLICATION
https_port = base+0 (main UI)  http_port = base+1
https_port2 = base+2           http_port2 = base+3   ... up to https_port6 = base+10, http_port6 = base+11
```

`load_deploy_config()` reads the values from `conf/deploy.ini`. The defaults are `RANGE_START=6000`, `RANGE_RESERVED=100` and `RANGE_PORTS_PER_APPLICATION=12`. The function returns ports in the order of `APP_PORT_COLUMNS` (`http_port, https_port, http_port2, …`). Use `APP_PORT_COLUMNS_SQL`, `APP_PORT_PLACEHOLDERS_SQL` and `APP_PORT_UPDATE_SQL` when you write to `user_applications`. The default user URL is `https://www.<DOMAIN>:<https_port>`.

> With the defaults, a user's block is 100 ports and each app takes 12. Apps with `app_id ≥ 9` therefore spill into the next user's range. Raise `RANGE_RESERVED` if you have more applications.

Inside `calculate_app_ports()` the `app_id` argument acts as the application's identity number. `deployApp.sh` takes that number from the deployed app's own `conf/deploy.ini` (`APPLICATION_IDENTITY_NUMBER`), and that value can differ from `applications.id`. `resolve_app_identity_number(user_name, app_name, fallback_app_id)` reads the deployed value from `/home/<LINUX_USER>/deployments/<user>/<app>/conf/deploy.ini` and falls back to `applications.id` when it can't. `scripts/fix_user_application_ports.py [--dry-run]` uses it to recompute every `user_applications` row: it rewrites all 12 port columns and the URL.

---

## 6. Health and inspection

**API:** `GET /api/health/database` (admins only) returns `{health, statistics}`. These come from `src/db_health.py`:
- `check_database_health()` runs `SELECT 1`. `tables_count` is a hard-coded placeholder (`0`) and `journal_mode` always reads `postgresql`.
- `get_database_stats()` returns row counts for the 14 core tables and `pg_database_size`.

**CLI** (`python3 scripts/controller_cli.py <cmd>`; see [../CLI_REFERENCE.md](../CLI_REFERENCE.md)):

| Command | Does |
|---|---|
| `init-db` | Runs `init_db()` |
| `db-health` | Prints health status and per-table counts plus DB size |
| `db-status [--show-env]` | Tests the connection; optionally shows the `POSTGRES_*` values, with the password masked |
| `list-tables` | All public tables with row counts |
| `describe-table [TABLE]` | Columns, types, nullability and defaults. Opens an interactive picker if no table is given. |
| `select-table [TABLE] [--limit 10]` | Shows table rows |
| `exec-sql-request "SQL"` | Runs arbitrary SQL, after a confirmation prompt |
| `delete-db` | ⚠️ Drops **every** public table (`CASCADE`) and removes `softfluid/postgres_data`, after a confirmation prompt |

---

## 7. Setup and reset scripts

- **`setup_postgresql.sh`** (native install):
  - Starts and enables the `postgresql` service.
  - Creates the `swautomorph` role with `CREATEDB` and the password `swautomorph_secure_password_2026`, creates the `ai_swautomorph` database and grants privileges.
  - Exports the `POSTGRES_*` variables for the current shell only, then runs `controller_cli.py init-db`.

  Put the same password in `.env`. The script's final verification step calls `controller_cli.py status --show-env`, but that command no longer exists. Run `db-status --show-env` instead.
- **Docker:** the `postgres` service in `docker-compose.yml` uses `postgres:15-alpine` with the data volume `postgres_data`, loads the schema on first init, and has a `pg_isready` healthcheck. `Dockerfile.postgres` (a python:3.11 image with `postgresql-client` that runs `src/ControlPlanFlaskApp_postgres.py`) isn't referenced by `docker-compose.yml` or by any script.
- **`scripts/reset_db.sh`:** ⚠️ destructive. It runs `dropdb` and `createdb`, then applies `scripts/postgresql_schema.sql` and calls `init_db()`. Credentials are hard-coded (`swautomorph` / `swautomorph_password` @ `localhost:5432`) and `.env` isn't read, so edit the script if your password is different. Run it from the repo root.

Backups and restores are covered in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).

---

## 8. SQLite leftovers

- `deployControlPlan.sh migrate_db` and `controller_cli.py migrate-db` only do something when `softfluid/db/ai_swautomorph.db` exists. In that case they call `migration/migrate_sqlite_to_postgres.py`, which **no longer exists**, so the command fails (the script runs with `set -e`). Without a SQLite file it prints a skip message. The Docker start path calls the same function under the same condition.
- `recover_db.py` and `src/db_health.py` still contain commented-out SQLite code.
