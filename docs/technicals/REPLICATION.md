# Multi-Server Setup and Database Replication

OPCP-explorer can run on several servers. Each server runs its own Flask app and its own PostgreSQL database. The servers know about each other through the `servers` table, and business data is copied between them by an **event-driven, peer-to-peer replication** over HTTPS.

There is **no automatic failover and no consensus**: roles (PRIMARY / SECONDARY) are labels managed by an admin, and replication is best-effort.

Related docs: [DATABASE.md](DATABASE.md), [NGINX_AND_DOMAINS.md](NGINX_AND_DOMAINS.md), [../CLI_REFERENCE.md](../CLI_REFERENCE.md), [../API_REFERENCE.md](../API_REFERENCE.md), [../SHARE_GPU_DOCKER.md](../SHARE_GPU_DOCKER.md) (per-server GPU endpoints).

| Component | File |
|---|---|
| Discovery and role helpers | `src/platform_discovery.py` |
| Replication queue, worker, apply logic | `src/replication_manager.py` |
| Replication receiver endpoints (`/api/sync/*`) | `src/routes/replication_routes.py` |
| Server / platform endpoints (`/api/platform/*`, `/api/servers*`, `/api/server/allocate`, `/api/replication/queue`) | `src/routes/api_routes.py` |
| Generic replication hook on every DB write | `DatabaseManager._queue_replication` in `src/database_postgres.py` |
| CLI commands | `scripts/controller_cli.py` |
| Admin UI | "Servers" tab of the dashboard (`templates/dashboard.html`) |

---

## 1. The `servers` table

Every server keeps its own copy of the server registry.

| Column | Values / meaning |
|---|---|
| `server_ip` | `INET`, unique. Used as the peer address for replication and discovery. |
| `server_name` | Free text. |
| `server_capacity_user_max`, `server_capacity_appli_max` | Capacity limits used by `/api/server/allocate`. |
| `server_status` | `STAND_BY` or `ACTIVE` (the UI offers only these). Replication skips peers whose status is `DISABLED`. |
| `server_type` | `STAND_ALONE`, `PRIMARY` or `SECONDARY`. |

On the very first `init_db()` an empty table is seeded with the local server: name `main-server`, type `STAND_ALONE`, status `STAND_BY`, capacity 10 users / 50 apps. The local IP is the source address of an outbound UDP socket to `8.8.8.8` (falls back to `127.0.0.1`).

---

## 2. Adding a server (discovery)

All `/api/servers*` endpoints require admin rights (user `admin` or `users.account_type = 'ADMIN'`, see `src/admin_auth.py`).

### From the dashboard (Servers tab)

1. Enter the remote IP and click **DISCOVER**. The browser calls `POST /api/servers/discover` (`{"remote_ip": "..."}`), which server-side calls `GET https://<remote_ip>:443/api/platform/status` (falls back to `http://<remote_ip>:443/...`, 5 s timeout, TLS not verified). If the remote answers with `"platform": "SwAutoMorph"` (the wire identifier is still the legacy name), the form is pre-filled with the remote name and role.
2. Click **Create**. The browser calls `POST /api/servers`, which:
   - runs discovery again;
   - if a platform was detected, computes the local role with `determine_role()` and writes it to the local server row (`update_server_role`), and stores the remote with the role it reported;
   - otherwise stores the remote with the `SERVER_TYPE` from the form (default `SECONDARY`).
3. If the remote was discovered, the browser then calls `POST /api/servers/add-remote`. This reads the local row whose `server_type = 'PRIMARY'` and posts it to the remote's public `POST /api/platform/servers/add`, so the remote also knows about the PRIMARY. It fails with `No PRIMARY server found in local database` if no PRIMARY exists locally.

`determine_role(current_ip, remote_ip, remote_status, db)`:

- remote reports `PRIMARY` → local becomes `SECONDARY`;
- otherwise the local row keeps its current `server_type`;
- if the local server is not registered → `PRIMARY`.

### From the CLI

```bash
python3 scripts/controller_cli.py discover-server <REMOTE_IP>   # probe remote, then update the LOCAL role
python3 scripts/controller_cli.py platform-status               # local role + all registered servers
```

`discover-server` only updates the local server's role; it does not insert the remote into `servers`. Use the dashboard (or `POST /api/servers`) to register it.

### Role management

| Action | Endpoint | Rule |
|---|---|---|
| Promote to PRIMARY | `POST /api/servers/<id>/promote` | Refused if any `PRIMARY` already exists. The UI enables the button only for `STAND_ALONE` servers. |
| Promote to SECONDARY | `POST /api/servers/<id>/promote-secondary` | No server-side check. The UI enables it only for `STAND_ALONE` servers when a PRIMARY exists. |
| Edit any field | `PUT /api/servers/<id>` | All six fields required (`SERVER_IP`, `SERVER_NAME`, `SERVER_CAPACITY_USER_MAX`, `SERVER_CAPACITY_APPLI_MAX`, `SERVER_STATUS`, `SERVER_TYPE`). |
| Delete | `DELETE /api/servers/<id>` | Refused while `server_status = 'ACTIVE'`. |
| Sync a SECONDARY | `POST /api/servers/<id>/sync` | See [Known limitations](#8-known-limitations): currently always fails. |

Failover is manual: if the PRIMARY is lost, edit the remaining servers (dashboard, `PUT /api/servers/<id>`, or SQL `UPDATE servers SET server_type = 'PRIMARY' WHERE server_ip = '<ip>';`). Each server's registry must be corrected on that server — role changes are not propagated as such (see the generic hook below).

### Deployment server allocation

`POST /api/server/allocate` (any logged-in user, body `{"application_name": "..."}`) returns `{"server_id": N}` for the first `STAND_BY`/`ACTIVE` server (ordered by status) whose distinct deployed users and distinct deployed apps (from `deployments.server_id`) are below its capacity limits (NULL limits count as 100). A selected `STAND_BY` server is switched to `ACTIVE`. Returns `503` when no server has capacity.

---

## 3. Replication model

```
DB write on server A
   │  (explicit queue_replication_event(...) or generic hook in execute_query)
   ▼
in-memory queue.Queue  ──►  worker thread  ──►  POST https://<peer>/api/sync/replicate   (fallback http)
                                                 header X-Sync-Token: <SYNC_SECRET>
                                                          │
                                                          ▼
                                       server B: apply_replication_event() on its own DB
```

- Peer-to-peer: every server pushes its own events to every other server listed in its `servers` table (status `!= 'DISABLED'`, excluding its own IP). There is no master; the PRIMARY/SECONDARY label plays no role in event propagation.
- Asynchronous and in-memory: the queue lives in the Flask process. Events still queued when the process stops are lost.
- Started at app startup in `create_app()` (`src/ControlPlanFlaskApp_postgres.py`): `ReplicationManager(db_manager, SYNC_SECRET).start_worker()` and `init_replication_routes(...)`.

### Replicated tables

`REPLICATED_TABLES` in `src/replication_manager.py`:

`USERS`, `SERVERS`, `APPLICATIONS`, `USER_APPLICATIONS`, `APPLICATION_COSTS`, `PAYMENT_MODES`, `BILLING_ACTIVITES` (sic), `AUTH_TOKENS`.

Events for other tables are dropped by `queue_replication_event()`. The receiver does **not** check this list: it applies whatever table the event names.

### Event sources

| Source | Where | Payload |
|---|---|---|
| User registration | `src/routes/auth_routes.py` (`/register`) | Named columns: `username`, `email`, `password_hash`, `first_name`, `last_name`, `suspended` |
| Application creation | `POST /api/applications` in `src/routes/api_routes.py` | Named columns: `name`, `description`, `git_url`, `git_repo_size` |
| Generic hook | `DatabaseManager.execute_query()` after commit, for `INSERT INTO` / `UPDATE` on `users`, `servers`, `applications`, `user_applications`, `billing_activities`, `auth_tokens` | `{"params": [...]}` (positional parameters only, no column names, no primary key) |
| Manual bulk push | CLI `replication-sync-table` / `replication-sync-all-tables` | Full rows (`SELECT *`) sent as `INSERT` events with `primary_key = {"id": ...}` |

The `replicate(table, operation)` decorator also exists in `replication_manager.py` but is not used anywhere.

### Event format

```json
{
  "event_id": "uuid4",
  "timestamp": "2026-01-15T10:30:00",
  "table": "users",
  "operation": "INSERT",
  "data": {"username": "alice", "email": "alice@example.com"},
  "primary_key": {"id": 123},
  "version": 1768473000000
}
```

`version` is the sender's clock in milliseconds.

### Sending (worker)

- Takes events from the queue one at a time and posts each to every peer (`https` first, then `http`), 5 s timeout, TLS verification disabled.
- Peer list: `SELECT server_ip FROM servers WHERE server_status != 'DISABLED'`, minus the local IP as returned by `socket.gethostbyname(socket.gethostname())`.
- Successfully sent events are removed from the `pending_events` monitor (capped at 1000 entries).

### Applying (receiver)

`POST /api/sync/replicate`:

1. `X-Sync-Token` must equal the local `SYNC_SECRET`, otherwise `401` (logged to `logs/replication_routes.log`).
2. The body must contain `event_id`, `timestamp`, `table`, `operation`, `data`, otherwise `400`.
3. Conflict check (UPDATE / DELETE with a primary key only): reads `updated_at` of the local row; if it is newer than the event `version`, the event is skipped (last write wins).
4. Apply:
   - `INSERT` → `INSERT ... ON CONFLICT (id) DO UPDATE SET <all columns except id>` (upsert);
   - `UPDATE` → `UPDATE <table> SET ... WHERE <pk_col> = <pk_val>`;
   - `DELETE` → `DELETE FROM <table> WHERE <pk_col> = <pk_val>`.
5. Response is `200 {"status": "applied"}` or `200 {"status": "skipped"}` (skipped also covers apply errors, which are logged).

---

## 4. Configuration

`SYNC_SECRET` is read from the environment (the app calls `load_dotenv()`, so `.env` in the platform folder works). It **must be identical on all servers**. If unset, the default `default-sync-secret-change-me` is used — change it.

```bash
# generate once, copy the same value to .env on every server
python3 -c "import secrets; print('SYNC_SECRET=' + secrets.token_hex(32))"
python3 scripts/controller_cli.py restart
```

The CLI bulk-sync commands read `SYNC_SECRET` from the same `.env`.

Network requirements: each server must reach every peer on TCP 443 (or 80 for the HTTP fallback). `deployControlPlan.sh` opens 80/443 with `ufw` during a local start.

---

## 5. Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/platform/status` | none (CORS `*`) | Discovery: `platform`, `version`, `role`, `server_ip`, `server_name`, `servers[]` |
| `POST /api/platform/servers/add` | **none** | Insert a server row (used by `add-remote`). Requires `SERVER_IP`, `SERVER_NAME`, `SERVER_CAPACITY_USER_MAX`, `SERVER_CAPACITY_APPLI_MAX`, `SERVER_STATUS`, `SERVER_TYPE`. Returns `200` if the IP already exists. |
| `POST /api/servers/discover` | admin | Server-side proxy to a remote `/api/platform/status` |
| `POST /api/servers/add-remote` | admin | Push the local PRIMARY row to a remote |
| `GET /api/servers` | admin | List servers + `local_ip` |
| `POST /api/servers` | admin | Add a server (with discovery) |
| `PUT` / `DELETE /api/servers/<id>` | admin | Update / delete |
| `POST /api/servers/<id>/promote`, `/promote-secondary`, `/sync` | admin | Role management |
| `POST /api/server/allocate` | logged in | Pick a server with free capacity |
| `GET /api/replication/queue` | admin | `queue_size` and the last 10 pending events |
| `POST /api/sync/replicate` | `X-Sync-Token` | Receive an event |
| `GET /api/sync/health` | none | `status`, `queue_size`, `timestamp` |
| `GET /api/sync/status` | none | `queue_size`, `peer_count`, `peers[]` (ip, name, type) |

Queue figures (`/api/sync/*`, `/api/replication/queue`) are per process. Gunicorn runs several workers (`gunicorn.conf.py`: `cpu_count * 2 + 1`), each with its own queue and replication worker thread, so a single request only shows the queue of the worker that served it.

---

## 6. CLI

```bash
python3 scripts/controller_cli.py platform-status                       # local role + registry
python3 scripts/controller_cli.py discover-server <IP>                  # probe remote, set local role
python3 scripts/controller_cli.py replication-sync-status               # registry, replicated tables, local row counts
python3 scripts/controller_cli.py replication-test-sync <IP>            # GET /api/sync/health on peer (https, then http)
python3 scripts/controller_cli.py replication-sync-all-tables <IP>      # push every row of the business tables to a peer
python3 scripts/controller_cli.py replication-sync-table <TABLE> <IP>   # push one table (see limitations)
```

`replication-sync-all-tables` pushes, in order: `users`, `application_costs`, `payment_modes`, `applications`, `auth_tokens`, `user_applications`, `billing_activities` (not `servers`). Each row is sent as an `INSERT` event, so the peer upserts by `id`. It is the practical way to bring a new or diverged server up to date.

---

## 7. Typical setup of a second server

1. Install OPCP-explorer on server B ([../INIT_PLATFORM.md](../INIT_PLATFORM.md)).
2. Put the same `SYNC_SECRET` in `.env` on A and B, then restart both.
3. On A, promote A to PRIMARY if it is still `STAND_ALONE` (Servers tab → Promote).
4. On A, Servers tab → DISCOVER B's IP → Create. A stores B, and B receives A's PRIMARY row through `/api/platform/servers/add`.
5. Check connectivity both ways: `replication-test-sync <peer_ip>`.
6. Seed B with A's data: on A, `replication-sync-all-tables <B_ip>`.
7. Verify with `replication-sync-status` on both servers (compare record counts).

---

## 8. Known limitations

These reflect the current code; check before relying on replication for anything critical.

- **No retries.** The worker has a retry list, but failed events are never added to it. A failed event stays in `pending_events` (and in `/api/replication/queue`) until evicted by the 1000-entry cap.
- **Generic hook events cannot be applied.** Their `data` is `{"params": [...]}` with no column names or primary key, so the receiver's SQL fails and the event is reported `skipped`. In practice only user registration, application creation and the CLI bulk push carry usable data.
- **Explicit events have no `id`.** Registration and application-creation events upsert on `id` without providing one, so the peer generates its own id; ids can diverge between servers, and a duplicate `username`/`email` on the peer makes the insert fail.
- **`BILLING_ACTIVITES` typo** in `REPLICATED_TABLES`: `billing_activities` events are dropped by `queue_replication_event()` (the CLI bulk push still sends them).
- **`replication-sync-table` is case-broken**: the whitelist check needs an upper-case name (`USERS`), but the column lookup in `information_schema` then finds nothing, so empty rows are sent. Use `replication-sync-all-tables`.
- **`POST /api/servers/<id>/sync` always fails**: it imports `trigger_full_sync` from `src/replication_manager.py`, which does not exist.
- **Self-IP detection differs**: the worker excludes `gethostbyname(hostname)` (may be `127.0.1.1`), while the server registry uses the outbound-socket IP. A server may therefore send events to itself.
- **UPDATE/DELETE conflict check** reads `updated_at`; on a table without that column the receiver returns `500`.
- **Security**: `/api/platform/servers/add`, `/api/sync/status` and `/api/sync/health` are unauthenticated; TLS certificates are never verified between peers. Restrict server-to-server traffic (firewall / VPN).
- `src/db_sync.py` (`DatabaseSync`, PRIMARY → SECONDARY pull) is an unused scaffold: `_sync_table()` is a no-op and nothing calls it.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Peer gets `401` | `SYNC_SECRET` differs; compare `.env` on both servers and restart. |
| `Cannot connect to <ip> on HTTPS or HTTP` in logs | `replication-test-sync <ip>`; firewall on 443/80; nginx up on the peer. |
| Discovery says "No SwAutoMorph platform detected" | `curl -k https://<ip>/api/platform/status` from the server (not the browser). |
| `add-remote` fails with "No PRIMARY server found" | Promote one local server to PRIMARY first. |
| Data diverged | Compare counts with `replication-sync-status`, then `replication-sync-all-tables <ip>` from the reference server. |
| Two PRIMARY servers | Edit the wrong one to `SECONDARY` on each server's registry (`PUT /api/servers/<id>` or SQL). |

Logs: replication messages are prefixed `[REPLICATION]` (app output and `logs/replication_routes.log`); discovery uses `[DISCOVERY]` and `[PLATFORM_SERVERS_ADD]` in `logs/api_routes.log`.
