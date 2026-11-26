# Backup and Recovery

This page covers how OPCP-explorer backs up and restores its own PostgreSQL database, how backups go to OVH S3, and how backup history is kept per deployment.

Related docs: [DATABASE.md](DATABASE.md) · [../CLI_REFERENCE.md](../CLI_REFERENCE.md) · [../DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) · [../API_REFERENCE.md](../API_REFERENCE.md)

---

## 1. Overview

| Piece | Where | What it does |
|---|---|---|
| `backup_database()` | `deployControlPlan.sh` | Runs `pg_dump` into `./softfluid/db/backup/<timestamp>/`, then syncs that folder to S3 |
| `recover_database()` | `deployControlPlan.sh` | Restores from a local or S3 backup. It takes a pre-recovery dump first. |
| `setup_backup_cron()` / `remove_backup_cron()` | `deployControlPlan.sh` | Add the hourly backup crontab entry on `start` and remove it on `stop` |
| `backup_logs()` | `deployControlPlan.sh` | Syncs `./logs` to S3 before `stop` |
| `recover_db.py` | repo root | Legacy helper that re-runs `init_db()` (see §6) |
| `scripts/mount_s3fs.py`, `mount-s3fs` CLI | | Mounts an OVH S3 bucket with `s3fs` |
| `deployments.backups_history` | DB + `/api/deployments/<id>/backup(s)` | Per-deployment JSON list of backup records |

You can run every platform-level command through the CLI wrapper or call the script directly:

```bash
python3 scripts/controller_cli.py backup-db     # == ./deployControlPlan.sh backup_db
python3 scripts/controller_cli.py recover-db    # == ./deployControlPlan.sh recover_db
```

`deployControlPlan.sh` also accepts `--backup_db` and `--recover_db`. Always run it from the repository root, because it reads `./conf/deploy.ini`, `./.env` and writes to `./softfluid/...` using relative paths.

---

## 2. Creating a backup (`backup_db`)

Steps that `backup_database()` runs:

1. Loads `POSTGRES_*` variables from `./.env`, if the file exists. The defaults are `localhost:5432`, database `ai_swautomorph`, user `swautomorph`.
2. Checks the server with `pg_isready` and aborts if the server isn't ready.
3. Creates `./softfluid/db/backup/<YYYYMMDD_HHMMSS>/` containing:

   | File | Content |
   |---|---|
   | `complete_database.sql` | `pg_dump --clean --if-exists --create` (full dump, used first on restore) |
   | `data_only.sql` | `pg_dump --data-only` (best-effort) |
   | `schema_only.sql` | `pg_dump --schema-only` (best-effort) |
   | `backup.log` | pg_dump stderr |

4. Syncs the folder to S3 (see §3). If the S3 sync fails, it prints a warning and the local backup stays.

### Automatic backups

- **Hourly cron:** `start` calls `setup_backup_cron`, which installs this entry:
  ```
  0 * * * * /abs/path/deployControlPlan.sh --backup_db >/dev/null 2>&1
  ```
  Any previous entry for the same script is replaced. `stop` calls `remove_backup_cron`.
- **On stop:** `stop` first removes the cron entry, then runs `backup_database` and then `backup_logs`. These steps are best-effort: a failure doesn't block the stop.

> ⚠️ The cron entry calls the script by absolute path but doesn't `cd` into the repo first. The script uses relative paths for `./conf/deploy.ini`, `./.env` and `./softfluid/db/backup`, so a cron run starts in the crontab user's home directory. Check that cron backups actually land where you expect, or wrap the entry with a `cd` (see the inconsistencies list in §8).

---

## 3. S3 layout (IP-based)

Backups are grouped by the public IPv4 of the server that made them. This lets several platform servers share one bucket without overwriting each other.

```
s3://<S3_BUCKET_NAME>/<PLTF_NAME>/db/backup/<SERVER_IP>/<YYYYMMDD_HHMMSS>/
    complete_database.sql
    data_only.sql
    schema_only.sql
    backup.log
s3://<S3_BUCKET_NAME>/<PLTF_NAME>/logs/          # backup_logs() on stop
```

- `S3_BUCKET_NAME` and `PLTF_NAME` come from `conf/deploy.ini`. The script defaults are `agentic-ai-plateform-s3` and `agentic-ai-plateform`. Inside the script `NAME_OF_APPLICATION` is set to `PLTF_NAME`.
- `SERVER_IP` comes from `get_server_ip()`. It tries `curl -4 ifconfig.me` / `icanhazip.com` (2 s timeout) and falls back to the first IPv4 from `hostname -I`.
- All `aws` calls use `--profile OVH-SWAUTOMORPH`. `init_pltf.sh` writes this profile to `~/.aws/config` and `~/.aws/credentials` (region `gra`, endpoint `https://s3.gra.io.cloud.ovh.net/`). Replace the placeholder keys with real credentials.

Useful checks:

```bash
aws s3 ls s3://<S3_BUCKET_NAME>/<PLTF_NAME>/db/backup/ --profile OVH-SWAUTOMORPH            # servers
aws s3 ls s3://<S3_BUCKET_NAME>/<PLTF_NAME>/db/backup/<SERVER_IP>/ --profile OVH-SWAUTOMORPH # backups
```

---

## 4. Restoring (`recover_db`)

`recover_database()` is interactive. It uses `simple_term_menu` arrow-key menus when that package is available, and numbered prompts otherwise.

1. **Choose the source:** local (`./softfluid/db/backup`) or remote S3.
2. **S3 only:** it lists the server IPs under `db/backup/` and puts the current server first, tagged `(current server)`. You pick a server, which lets you restore another server's backup onto this one. The AWS CLI must be installed.
3. **Choose a backup.** Folders are listed newest first.
4. **S3 only:** it downloads the backup to `./softfluid/db/backup/s3-temp-<ip>-<timestamp>/` and deletes that folder after the restore.
5. **Pre-recovery dump:** it dumps the current DB to `./softfluid/db/backup/pre-recovery-<timestamp>/complete_database.sql`.
6. **Restore:**
   - If `complete_database.sql` exists, it terminates the other connections to the DB, then runs the file with `psql` against the `postgres` database. The dump contains `DROP DATABASE` / `CREATE DATABASE`. Output goes to `restore.log`.
   - Otherwise, if both `schema_only.sql` and `data_only.sql` exist, it runs `DROP DATABASE`, then `CREATE DATABASE ... OWNER $POSTGRES_USER`, then restores the schema and then the data.
   - Otherwise it aborts.

To restore the DB, the `POSTGRES_USER` role must be allowed to drop and create the database. `setup_postgresql.sh` grants `CREATEDB`.

Unlike `backup_database`, `recover_database` doesn't load `.env` itself. It relies on the variables already exported in the shell, or on its defaults.

**Restarting after a restore:** `python3 scripts/controller_cli.py restart`.

---

## 5. Mounting S3 with s3fs

The script and the CLI command run the same `s3fs` command, using the OVH endpoint `https://s3.gra.cloud.ovh.net` and `use_path_request_style`:

```bash
python3 scripts/mount_s3fs.py <bucket_name> <mount_point>                   # uses ./.passwd-s3fs
python3 scripts/controller_cli.py mount-s3fs <bucket_name> <mount_point> [--passwd-file .passwd-s3fs]
```

`s3fs` must be installed, and the password file (`ACCESS_KEY:SECRET_KEY`, mode 600) must exist. Backups don't use this mount, because they rely on the AWS CLI. It's only a convenience for browsing the bucket.

---

## 6. `recover_db.py` (legacy)

`recover_db.py` at the repo root dates from the SQLite era. Here is what it does:

- If `/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/softfluid/db/ai_swautomorph.db` exists, it copies that file to `...db.backup_<timestamp>` and deletes the file along with its `-shm` and `-wal` files.
- It calls `src.database_postgres.init_db()`.

On a PostgreSQL install it doesn't restore anything. It only re-runs `init_db()`, which is idempotent: it creates the schema if the `users` table is missing and applies the auto-migrations. To restore data, use `recover-db`.

---

## 7. Per-deployment backup history

### Data model

`deployments.backups_history` is a `JSONB` column (default `[]`) with a GIN index (`idx_deployments_backups_history`). Fresh installs get it from `scripts/postgresql_schema.sql`. Older databases need a manual migration, because `init_db` does not apply this file:

```bash
psql -U swautomorph -d ai_swautomorph -f migration/add_backups_history_to_deployments.sql
```

Each entry looks like this:

```json
{
  "backup_file": "app_20260228_143022.sql.gz",
  "s3_location": "s3://<bucket>/.../app_20260228_143022.sql.gz",
  "backup_size": "15M",
  "backup_date": "2026-02-28 14:30:22",
  "server_ip": "<ip>",
  "created_by": 1
}
```

### API (`src/routes/api_routes.py`)

| Method & path | Access | Body / result |
|---|---|---|
| `POST /api/deployments/<id>/backup` | Logged-in deployment owner or admin | JSON `backup_file` and `s3_location` are required. `backup_size`, `backup_date` and `server_ip` are optional; `backup_date` defaults to now and `created_by` is the session user. The entry is appended with `COALESCE(backups_history,'[]') \|\| entry`. Returns `{message, backup_entry}`. |
| `GET /api/deployments/<id>/backups` | Owner or admin | `{"backups_history": [...]}` |

404 means the deployment doesn't exist, 403 means the caller is neither owner nor admin, and 401 means no session.

### Helper scripts

```bash
# Append an entry straight into the DB (no HTTP)
python3 scripts/add_backup_to_deployment.py --deployment-id 42 \
    --backup-file app_20260228.sql.gz --s3-location s3://<bucket>/... \
    [--backup-size 15M] [--server-ip <ip>] [--user-id 1]

# Sanity test: checks column + GIN index, then appends a test entry to the most
# recently updated deployment and reads it back (the test entry is NOT removed)
python3 scripts/test_backups_history.py
```

Nothing in the platform calls `add_backup_to_deployment.py` automatically. A per-application backup script has to call it, or call the POST endpoint, after it uploads a dump. Both scripts currently fail at import time (see §8).

---

## 8. Deployments Management (admin)

The **Deployments** tab of the dashboard is visible to admins only: user `admin`, or users with `users.account_type = 'ADMIN'` (see `src/admin_auth.py`). It shows every row of the `deployments` table.

- **Filters:** user, application and status. The status list is built from the statuses actually present. **Refresh** reloads the table.
- **Columns:** ID, user, app ID and name, status, path, Git URL, server, platform URL, Modification History (listbox), **Backups History** (listbox showing `backup_date (backup_size)`; clicking an entry copies its `s3_location` to the clipboard), and Actions. The columns are sortable except the two listboxes.
- **Actions:** ✏️ Edit, 🗑️ Delete, 🔄 Update Nginx.

| Endpoint | Purpose |
|---|---|
| `GET /api/deployments/all` | Admin: every deployment, `backups_history` included, ordered by `updated_at DESC` |
| `DELETE /api/deployments/<id>` | Admin: delete the deployment record only. It does not stop containers or remove files. |
| `POST /api/nginx/update-deployment` | Admin: (re)write the nginx location for `{user_id, app_name, deployment_url, user_appli_url}` |

### Known issues in the current code

- **✏️ Edit is broken.** The UI sends `PUT /api/deployments/<id>`, but only `DELETE` is registered on that route, so the request fails with 405.
- **🔄 Update Nginx fails client-side.** `updateNginxForDeployment()` references an undefined `targetUrl` variable. Also, `/api/deployments/all` doesn't return `deployment_url` or `user_appli_url`, so the button would send empty values anyway.
- **`add_backup_to_deployment.py` and `test_backups_history.py` fail at import.** Both import `DatabaseManager` from `src.database_postgres`, which only exports `PostgreSQLManager` and the `db_manager` singleton.
- **Cron backups run from the wrong directory.** The cron entry doesn't `cd` to the repo root, so it doesn't use the repo's relative paths (see §2).
