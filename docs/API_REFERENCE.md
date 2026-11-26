# OPCP-explorer HTTP API Reference

This page lists every HTTP route the OPCP-explorer control plane registers
(`src/ControlPlanFlaskApp_postgres.py`, `create_app()`). The display name of
the platform comes from `PLTF_NAME` in `conf/deploy.ini`. The examples use
`https://<DOMAIN>` as the base URL.

All handlers are in `src/routes/*.py`. Blueprints are registered in this order,
which decides which handler runs when two blueprints define the same rule (see
[Duplicate routes](#duplicate-and-shadowed-routes)):

| # | Blueprint | URL prefix | File |
|---|-----------|------------|------|
| 1 | `main_bp` | `/` | `main_routes.py` |
| 2 | `auth_bp` | `/` | `auth_routes.py` |
| 3 | `sso_bp` | `/sso` | `sso_routes.py` |
| 4 | `api_bp` | `/api` | `api_routes.py` |
| 5 | `genai_bp` | `/api` | `genai_routes.py` |
| 6 | `billing_bp` | none (paths start with `/api/billing/`) | `billing_routes.py` |
| 7 | `orchestrator_bp` | `/api/orchestrator` | `orchestrator_routes.py` |
| 8 | `replication_bp` | none (paths start with `/api/sync/`) | `replication_routes.py` |
| 9 | `security_bp` | `/security` | `security_routes.py` |
| 10 | `serverless_bp` | `/api` | `serverless_routes.py` |
| 11 | `gpu_bp` | `/api/servers/<int:server_id>/gpu` | `gpu_routes.py` |
| 12 | `templates_bp` | `/api` | `templates_routes.py` |
| 13 | `wizard_bp` | `/api/wizard` | `wizard_routes.py` |
| 14 | `sandbox_bp` | `/api` | `sandbox_routes.py` |

Related documentation: [USER_GUIDE.md](USER_GUIDE.md),
[CLI_REFERENCE.md](CLI_REFERENCE.md), [SERVERLESS.md](SERVERLESS.md),
[SHARE_GPU_DOCKER.md](SHARE_GPU_DOCKER.md),
[LIST_OF_APP_AVAILABLE.md](LIST_OF_APP_AVAILABLE.md),
[technicals/REPLICATION.md](technicals/REPLICATION.md),
[technicals/NGINX_AND_DOMAINS.md](technicals/NGINX_AND_DOMAINS.md),
[technicals/BACKUP_AND_RECOVERY.md](technicals/BACKUP_AND_RECOVERY.md),
[technicals/ORCHESTRATOR.md](technicals/ORCHESTRATOR.md),
[technicals/DATABASE.md](technicals/DATABASE.md),
[technicals/VIRTUAL_AGENTS.md](technicals/VIRTUAL_AGENTS.md).

---

## Contents

- [Authentication](#authentication)
- [Auth levels used in this page](#auth-levels-used-in-this-page)
- [Pages and miscellaneous (main_bp)](#pages-and-miscellaneous-main_bp)
- [Login, registration, SSO](#login-registration-sso-auth_bp-sso_bp)
- [Security: passwords and 2FA](#security-passwords-and-2fa-security_bp)
- [Applications](#applications)
- [Users](#users)
- [Deployments](#deployments)
- [Servers and platform discovery](#servers-and-platform-discovery)
- [Database, configuration, nginx, replication queue (admin tools)](#database-configuration-nginx-replication-queue-admin-tools)
- [Virtual agents (genai_bp)](#virtual-agents-genai_bp)
- [Billing](#billing-billing_bp)
- [Orchestrator](#orchestrator-orchestrator_bp)
- [Replication sync (peer-to-peer)](#replication-sync-replication_bp)
- [Serverless jobs](#serverless-jobs-serverless_bp)
- [Shared GPU (MIG)](#shared-gpu-mig-gpu_bp)
- [Deploy templates](#deploy-templates-templates_bp)
- [Setup wizard](#setup-wizard-wizard_bp)
- [Sandbox / demo mode](#sandbox--demo-mode-sandbox_bp)
- [Duplicate and shadowed routes](#duplicate-and-shadowed-routes)

---

## Authentication

### Session cookie

The API uses the Flask **session cookie** (the default cookie name is
`session`). The cookie is signed with `SECRET_KEY` (environment variable). A
request is authenticated when the session contains `user_id`. No route reads
an `Authorization: Bearer ...` header. The SSO token is **not** accepted as
API credentials: it only authenticates users to external applications (see
below).

CORS is enabled with `supports_credentials=True` for the origins in
`CORS_ORIGINS` (`src/config_postgres.py`).

### Logging in: `POST /login`

`POST /login` accepts **either** a JSON body (`Content-Type: application/json`)
**or** an HTML form body (`application/x-www-form-urlencoded`). Both use the
fields `username` and `password`.

| Outcome | JSON request | Form request |
|---------|--------------|--------------|
| Missing fields | `400 {"error": ...}` | same (JSON) |
| Unknown user or wrong password | `401 {"error": ...}` | same (JSON) |
| Account suspended (pending activation) | `403 {"error": ...}` | same (JSON) |
| 2FA enabled (TOTP and/or email) | `200 {"requires_2fa": true, "methods": ["totp","email"], "user_id": N, "message": ...}` | same (JSON) |
| Success | `200 {"message": "Login successful", "sso_token": "..."}` | `302` redirect to `/dashboard` |

On success the server sets `session['user_id']`, creates a new SSO token
(`session['sso_token']`, valid for one week, stored hashed in `auth_tokens`;
any previous token of that user is deleted) and writes a `login` row in
`users_logs`.

```bash
# Log in and store the session cookie
curl -c cookies.txt -H 'Content-Type: application/json' \
     -d '{"username":"alice","password":"secret"}' \
     https://<DOMAIN>/login

# Reuse the cookie on later calls
curl -b cookies.txt https://<DOMAIN>/api/auth/status
```

### Two-factor login flow

When `/login` answers `requires_2fa: true`, the session only holds
`pending_2fa_user_id` (the user is **not** logged in yet). To finish:

1. (Email method only) `POST /security/2fa/send-email-code` with
   `{"user_id": N}`, or an empty JSON object `{}` (the server then uses the
   pending user id from the session). A 6-digit code valid for 5 minutes is
   emailed.
2. `POST /security/2fa/verify-login` with
   `{"code": "123456", "method": "totp"}` (or `"method": "email"`). For
   `totp`, a backup code is also accepted; it is used up once accepted.
3. On success the response is
   `200 {"message": "Login successful", "sso_token": "...", "redirect": "/dashboard"}`
   and `session['user_id']` is set. A `login_2fa` row is written in `users_logs`.

```bash
curl -b cookies.txt -c cookies.txt -H 'Content-Type: application/json' \
     -d '{"code":"123456","method":"totp"}' \
     https://<DOMAIN>/security/2fa/verify-login
```

### SSO tokens

The SSO token is issued at login. External applications use it like this:

- `POST /sso/validate` with `{"token": "..."}` returns
  `{"valid": true, "user": {id, username, email, first_name, last_name, expires_at}}`
  or `401 {"valid": false}`.
- `POST /auth/sso` with `{"sso_token": "..."}` returns
  `{"access_token": "...", "user": {...}}` (the shape a React `AuthContext`
  expects) or `401`.
- `GET /sso/auth?redirect_uri=...&client_id=...` starts a redirect-based SSO
  flow. If the browser already has a session, it is redirected to
  `<redirect_uri>?token=<sso_token>&state=success`. If not, it goes to
  `/sso/login`, whose form posts to `/sso/authenticate`.
- `GET /sso/app/<app_name>` redirects a logged-in user to the stored
  `applications.url` with the token added in several query parameters
  (`sso_token`, `token`, `access_token`, `id_token`, `code`, ...).

`GET /logout` deletes the SSO token, clears `user_id`/`sso_token` from the
session, and redirects to `/`.

### Public endpoints (no session required)

| Path | Notes |
|------|-------|
| `GET /`, `GET /docs`, `GET /docs/<file>.md`, `GET /userguide`, `GET /favicon.ico`, `GET /set_language/<lang>`, `GET /.well-known/pki-validation/<file>` | Pages and static files |
| `GET, POST /register`, `POST /login`, `GET /logout`, `POST /auth/sso` | Auth |
| `POST /sso/validate`, `GET /sso/auth`, `GET /sso/login`, `POST /sso/authenticate` | SSO |
| `GET /api/auth/status` | Returns `authenticated` and the session's `sso_token` |
| `GET /api/users/id?username=<name>` | Looks up a user id by username (public on purpose) |
| `GET /api/applications` | Full application catalog (GET only; POST needs admin) |
| `GET /api/platform/status`, `POST /api/platform/servers/add` | Cross-platform discovery |
| `GET /api/sync/health`, `GET /api/sync/status` | Replication health |
| `POST /api/sync/replicate` | Protected by the `X-Sync-Token` header, not by a session |
| `GET /security/password-reset/<token>`, `POST /security/password-reset/<token>` | Protected by the reset token |
| `POST /security/2fa/send-email-code`, `POST /security/2fa/verify-login` | Login-time 2FA |
| All `/api/wizard/*` routes | Installer flow; no session check |

---

## Auth levels used in this page

| Level | Meaning |
|-------|---------|
| **public** | No check. |
| **user** | `user_id` in the session, otherwise `401`. |
| **owner/admin** | Logged in, and either the resource belongs to the caller or the caller has admin rights. |
| **admin** | Logged in **and** admin rights, otherwise `403`. Admin rights mean username `admin` (the super admin) **or** `users.account_type = 'ADMIN'`. Handlers check this with `ADMIN_CHECK_QUERY` from `src/admin_auth.py`. |
| **super-admin** | Only the built-in `admin` user. |
| **session-flag admin** | The handler checks `session['is_admin']` instead of `ADMIN_CHECK_QUERY`. **No code ever sets this key**, so these routes currently return `403` to every caller (see [Shared GPU](#shared-gpu-mig-gpu_bp) and `GET /api/jobs/metrics`). |
| **sync-token** | `X-Sync-Token` header equal to the `SYNC_SECRET` environment variable. |
| **reset-token** | The URL carries a valid, unused, unexpired password-reset token. |

---

## Pages and miscellaneous (`main_bp`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | public | Login page. Redirects to `/dashboard` if a session exists. |
| GET | `/dashboard` | user (redirects to `/` if not) | Dashboard HTML. Lists the caller's assigned applications and passes `is_admin`/`is_super_admin` to the template. |
| GET | `/set_language/<language>` | public | Sets `session['language']` (`en` or `fr`), then redirects to the referrer. |
| GET | `/docs` | public | Lists the `.md` files in `docs/`. |
| GET | `/docs/<filename>` | public | Renders a `.md` file from `docs/` (other extensions return `400`). |
| GET | `/userguide` | public | Renders `docs/USER_GUIDE.md`. |
| GET | `/favicon.ico` | public | Static favicon. |
| GET | `/servers/<int:server_id>/gpu` | session-flag admin | Shared GPU page (`shared_gpu.html`). Redirects to `/` if not logged in, otherwise returns `403` (see the auth level note). |
| GET | `/.well-known/pki-validation/<filename>` | public | Serves SSL validation files from `static/.well-known/pki-validation/`. |

---

## Login, registration, SSO (`auth_bp`, `sso_bp`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/register` | public | Registration page. |
| POST | `/register` | public | Creates a user that stays **suspended** until an admin activates it. JSON or form fields: `username`, `email`, `password` (required), `first_name`, `last_name`. JSON request: `201`. Form request: redirect to `/`. Duplicate: `409`. |
| POST | `/login` | public | See [Authentication](#logging-in-post-login). |
| GET | `/logout` | public | Logs out (see above). |
| POST | `/auth/sso` | public | Validates `{"sso_token"}`. Returns `access_token` and `user`. |
| POST | `/sso/validate` | public | Validates `{"token"}`. Returns `valid` and `user`. |
| GET | `/sso/app/<app_name>` | user (redirects to `/`) | Redirects to the application URL with the SSO token. `404` if the application does not exist. |
| GET | `/sso/auth` | public | Starts the redirect SSO flow. `redirect_uri` is required. `client_id` defaults to `ai-haccp`. |
| GET | `/sso/login` | public | SSO login form. Needs `sso_redirect_uri` in the session. |
| POST | `/sso/authenticate` | public | Form fields `username`, `password`. On success, redirects to `<redirect_uri>?token=...&state=success`. |

```bash
curl -X POST https://<DOMAIN>/register -H 'Content-Type: application/json' \
     -d '{"username":"bob","email":"bob@example.com","password":"S3cret!"}'
```

---

## Security: passwords and 2FA (`security_bp`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/security/password-reset/request` | user (any user for own account; admin for any account) | Body `{"user_id": N}` (optional: defaults to the caller). Emails a reset link valid for 1 hour. If the email fails, an admin caller gets `reset_url` in the response. |
| GET | `/security/password-reset/<token>` | reset-token | HTML reset form. |
| POST | `/security/password-reset/<token>` | reset-token | Form or JSON fields `new_password`, `confirm_password` (at least 6 characters). Marks the token as used. |
| POST | `/security/change-password` | user | `{"current_password", "new_password"}` (new password: at least 6 characters). |
| POST | `/security/2fa/setup` | user | Creates a TOTP secret. Returns `secret` and `provisioning_uri` (issuer `PLTF_NAME`). |
| POST | `/security/2fa/verify-setup` | user | `{"code"}`. Turns TOTP on and returns 8 `backup_codes`. |
| POST | `/security/2fa/disable` | user (own account, `password` required) / admin (any `user_id`, no password) | `{"user_id"?, "password"?}`. Turns off both TOTP and email 2FA. |
| POST | `/security/2fa/enable-email` | user | Turns on email-based 2FA for the caller. |
| POST | `/security/2fa/send-email-code` | public | `{"user_id"?}`. Emails a 6-digit code (valid 5 minutes). |
| POST | `/security/2fa/verify-login` | public (needs `pending_2fa_user_id` in the session) | `{"code", "method": "totp"|"email"}`. Completes the login. |
| GET | `/security/2fa/status` | user | `{"totp_enabled", "email_enabled", "any_enabled"}` |
| GET | `/security/2fa/admin-status/<int:user_id>` | admin | Same payload, for any user. |

---

## Applications

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/applications` | public | All applications: `id, name, url, description, git_url, git_repo_size, docker_build_duration, docker_start_duration, docker_stop_duration, docker_ps_duration`. |
| POST | `/api/applications` | admin | Creates an application and assigns it to every user. |
| GET | `/api/applications/pdf-data` | admin | `{"applications": [...], "domain": DOMAIN}`, used for the PDF catalog. |
| GET | `/api/applications/available` | user | Applications **not** assigned to the caller. |
| PUT | `/api/applications/<int:app_id>` | admin | Updates an application. Can also change its id. |
| DELETE | `/api/applications/<int:app_id>` | admin | Deletes an application. |

**POST `/api/applications`** body: `name` (required), `description`,
`git_url`, `git_repo_size` (default 50).

**PUT `/api/applications/<id>`** body: `name` (required), `url`,
`description`, `git_url`, `git_repo_size`, `docker_build_duration`,
`docker_start_duration`, `docker_stop_duration`, `docker_ps_duration`, and
`new_id` (optional, must be unused). When `new_id` is given, the
`user_applications`, `deployments`, `application_costs` and
`billing_activities` references are moved in one transaction. A changed `url`
is copied to every `user_applications.url` row; an unchanged `url` leaves
those rows alone.

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/applications \
     -H 'Content-Type: application/json' \
     -d '{"name":"my-app","description":"Demo","git_url":"https://github.com/org/my-app.git"}'
```

---

## Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users` | admin | All users: `id, username, email, first_name, last_name, suspended, created_at, totp_enabled, email_2fa_enabled, account_type, is_admin`. |
| POST | `/api/users` | admin | Creates an active user, assigns the default applications, and creates the matching Gitea user. |
| GET | `/api/users/id?username=<name>` | public | `{"id", "username"}` or `404`. |
| PUT | `/api/users/<int:user_id>` | admin (only the super admin may change the `admin` account) | Suspend, unsuspend, or edit. |
| DELETE | `/api/users/<int:user_id>` | admin (only the super admin may delete `admin`) | Deletes the user. |
| POST | `/api/users/<int:user_id>/admin` | **super-admin** | Grants or revokes admin rights (`account_type = 'ADMIN'`). |
| GET | `/api/users/<int:user_id>/applications` | admin | `{"assigned": [...], "all": [...]}` |
| POST | `/api/users/<int:user_id>/applications` | admin | `{"application_id"}`: assigns the application, computes its ports and URL (`https://<DOMAIN>:<port>`), and adds an nginx location. `409` if already assigned. |
| DELETE | `/api/users/<int:user_id>/applications` | admin | `{"application_id"}` (JSON body): unassigns the application and removes its nginx location. |

**POST `/api/users`** body: `username`, `email`, `password` (required),
`first_name`, `last_name`.

**PUT `/api/users/<id>`** body: `action` is one of:

| `action` | Extra fields | Effect |
|----------|--------------|--------|
| `suspend` | none | `suspended = TRUE` |
| `unsuspend` | none | `suspended = FALSE` (this is how registrations are activated) |
| `update` | `username`, `email` (required), `first_name`, `last_name` | Edits the profile. `409` on duplicate. |

Any other `action` value changes nothing but still returns `200`.

**POST `/api/users/<id>/admin`** body: `{"admin": true|false}` (default
`true`). Returns `400` for the `admin` account itself, and for accounts whose
`account_type` is set to something other than `ADMIN` (for example the sandbox
demo user). Writes `admin_granted`/`admin_revoked` to `users_logs`.

```bash
curl -b cookies.txt -X PUT https://<DOMAIN>/api/users/42 \
     -H 'Content-Type: application/json' -d '{"action":"unsuspend"}'

curl -b cookies.txt -X POST https://<DOMAIN>/api/users/42/admin \
     -H 'Content-Type: application/json' -d '{"admin":true}'
```

---

## Deployments

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/deployments` | user | The caller's deployments: `id, application_id, application_name, status, deployment_path, git_url, created_at, updated_at, server_id`. |
| POST | `/api/deployments` | user (admin to act for another user) | Clones the application, or runs a lifecycle action. See below. |
| GET | `/api/deployments/all` | admin | All deployments, including `swautomorph_url`, `modification_history` and `backups_history`. |
| DELETE | `/api/deployments/<int:deployment_id>` | admin | Deletes the deployment **record** only (no files or containers are removed). |
| GET | `/api/deployments/<int:deployment_id>/logs` | user (own deployment) | Contents of `<deployment_path>/deployment.log`. |
| GET | `/api/deployments/<app_name>/gitea` | user | `{"gitea_branch_url", "modification_history"}` for the caller's latest deployment of `app_name`. |
| POST | `/api/deployments/<app_name>/gitea/branch` | user | `{"branch_url"}`: updates `gitea_branch_url` on the caller's deployments of `app_name`. |
| POST | `/api/deployments/<int:deployment_id>/backup` | owner/admin | Adds an entry to `backups_history`. |
| GET | `/api/deployments/<int:deployment_id>/backups` | owner/admin | `{"backups_history": [...]}` |

### POST `/api/deployments`

| Field | Required | Notes |
|-------|----------|-------|
| `action` | yes | See the table below. |
| `application_name` | yes | Application name. The deployment folder is `<deployments prefix><username>/<name lowercased, spaces replaced by ->`. |
| `git_url` | for `clone` | Repository to clone. |
| `server_id` | for `clone` | Target server (`servers.id`), usually from `/api/server/allocate`. |
| `target_user_id` | no | Admin only: run the action for another user (`403` for non-admins, `404` if the user does not exist). |
| `stream` | no | `true` returns `text/event-stream` (Server-Sent Events) instead of JSON. |

Accepted `action` values:

| `action` | Case | Behavior |
|----------|------|----------|
| `clone` | exact, lowercase | On a local server: a GitHub URL is deleted and cloned again; any other URL (Gitea/localhost) is updated with `git fetch` + `git remote set-url` + `git checkout -B main origin/main`, or cloned if the folder does not exist. On a remote server the same steps run over SSH. Afterward it adds the nginx location, copies or obtains SSL certificates into `<path>/ssl`, and upserts the `deployments` row with `status = 'cloned'`. Returns `202` (`{"message", "status", "logs"}`). |
| `start`, `stop`, `restart`, `ps`, `logs` | any case | Runs `<deployment_path>/deployApp.sh <action> <user_id> "<first last>" <email> <runtime_type>` with the `RUNTIME_TYPE` env var (`runc` or `kata`). Updates `deployments.status` (`RUNNING`/`STOPPED`/`COMPLETED`). A successful `START`/`STOP` records a billing activity. Returns `200 {"message", "status", "logs"}`. |

If the application has no deployment, or `deployApp.sh` is missing, the
handler returns **`202`** with `{"error": ...}`. Any other `action` returns
`400`, a timeout returns `408`, and other errors return `500`.

**Streaming (`"stream": true`).** The response is `text/event-stream` with
`Cache-Control: no-cache` and `X-Accel-Buffering: no`. Each event is a line
`data: <json>` followed by a blank line:

- `{"chunk": "<output line, ANSI codes removed>"}`: one per line of output.
- `{"done": true, "success": <bool>}`: the last event.
- `{"error": "..."}`: sent if an exception happens while streaming.

For `clone`, streaming only applies after a successful clone (a short summary
is sent as chunks).

```bash
# Clone (server_id from /api/server/allocate)
curl -b cookies.txt -X POST https://<DOMAIN>/api/deployments \
     -H 'Content-Type: application/json' \
     -d '{"action":"clone","application_name":"my-app","git_url":"https://github.com/org/my-app.git","server_id":1}'

# Start with streamed output
curl -N -b cookies.txt -X POST https://<DOMAIN>/api/deployments \
     -H 'Content-Type: application/json' \
     -d '{"action":"start","application_name":"my-app","stream":true}'
```

### Backups history

**POST `/api/deployments/<id>/backup`** body: `backup_file`, `s3_location`
(both required), `backup_size`, `backup_date` (defaults to now), and
`server_ip`. The entry is appended to the `backups_history` JSONB array with
`created_by` set to the caller. See
[technicals/BACKUP_AND_RECOVERY.md](technicals/BACKUP_AND_RECOVERY.md).

---

## Servers and platform discovery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/servers` | admin | `{"servers": [{id, SERVER_IP, SERVER_NAME, SERVER_CAPACITY_USER_MAX, SERVER_CAPACITY_APPLI_MAX, SERVER_STATUS, SERVER_TYPE, created_at}], "local_ip"}` |
| POST | `/api/servers` | admin | Adds a server. First probes it with discovery: if another OPCP-explorer platform answers, the local role is updated and the remote role is reused. |
| PUT | `/api/servers/<int:server_id>` | admin | Replaces all fields (all 6 `SERVER_*` keys are required). |
| DELETE | `/api/servers/<int:server_id>` | admin | Refused (`400`) when `SERVER_STATUS` is `ACTIVE`. |
| POST | `/api/servers/<int:server_id>/promote` | admin | Sets the server to `PRIMARY`, only if there is no `PRIMARY` yet. |
| POST | `/api/servers/<int:server_id>/promote-secondary` | admin | Sets `server_type = 'SECONDARY'`. |
| POST | `/api/servers/<int:server_id>/sync` | admin | Runs a full replication from the `PRIMARY` to this `SECONDARY` server. |
| POST | `/api/servers/discover` | admin | `{"remote_ip"}`: calls the remote `/api/platform/status` from the server side. `404` if no platform is detected. |
| POST | `/api/servers/add-remote` | admin | `{"remote_ip"}`: sends the local `PRIMARY` record to `https://<remote_ip>/api/platform/servers/add`. |
| POST | `/api/server/allocate` | user | Picks a server for a deployment. Note: the path uses the singular `server`. |
| GET | `/api/platform/status` | public | `{"platform", "version", "role", "server_ip", "server_name", "servers": [...]}` with `Access-Control-Allow-Origin: *`. |
| POST | `/api/platform/servers/add` | public | Adds a server record sent by a peer platform (used by `add-remote`). |

**POST `/api/servers`** body: `SERVER_IP`, `SERVER_NAME`,
`SERVER_CAPACITY_USER_MAX`, `SERVER_CAPACITY_APPLI_MAX`, `SERVER_STATUS`
(required), and `SERVER_TYPE` (used when discovery finds nothing; default
`SECONDARY`). Response: `201 {"message", "discovered", "server_type"}`.

**POST `/api/platform/servers/add`** requires all six keys, including
`SERVER_TYPE`. It returns `200` with `server_id` when the IP is already
known, or `201` otherwise.

### POST `/api/server/allocate`

Body: `{"application_name": "<name>"}` (required).

Candidates are servers whose `server_status` is `STAND_BY` or `ACTIVE`. The
handler counts distinct users and distinct applications in `deployments` for
each server. It returns the first server under both `server_capacity_user_max`
and `server_capacity_appli_max` (NULL counts as 100). A `STAND_BY` server it
picks is switched to `ACTIVE`.

- `200 {"server_id": N}`
- `503 {"error": "No standby servers available"}` or `"All servers at capacity"`

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/server/allocate \
     -H 'Content-Type: application/json' -d '{"application_name":"my-app"}'
```

See [technicals/REPLICATION.md](technicals/REPLICATION.md) for the
PRIMARY/SECONDARY model.

---

## Database, configuration, nginx, replication queue (admin tools)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health/database` | admin | `{"health", "statistics"}` |
| GET | `/api/database/tables/<table_name>` | admin | `{"columns", "rows"}`: the last 100 rows, ordered by `id DESC`. |
| POST | `/api/database/tables/<table_name>` | admin | Inserts a row. The JSON object keys are column names. |
| PUT | `/api/database/tables/<table_name>/<record_id>` | admin | Updates a row by `id` (the `id` key is ignored). |
| DELETE | `/api/database/tables/<table_name>/<record_id>` | admin | Deletes a row by `id`. |
| GET | `/api/configuration` | admin | `configuration` rows: `param_id, parent, key, value`. |
| POST | `/api/configuration` | admin | `{"parent"?, "key", "value"}` → `201` |
| PUT | `/api/configuration/<int:param_id>` | admin | `{"parent"?, "key", "value"}` |
| DELETE | `/api/configuration/<int:param_id>` | admin | Deletes a parameter. |
| POST | `/api/nginx/sync` | admin | Rebuilds every nginx location from the database. |
| POST | `/api/nginx/update-deployment` | admin | `{"user_id", "app_name", "deployment_url", "user_appli_url"?}`: inserts or updates one location. |
| GET | `/api/replication/queue` | admin | `{"queue_size", "events"}` (the last 10 pending events). |

Allowed `<table_name>` values: `users`, `applications`, `auth_tokens`,
`user_applications`, `deployments`, `servers`, `instances`, `services`,
`application_costs`, `billing_activities`, `users_logs`, `payment_modes`,
`invoicing`. See [technicals/DATABASE.md](technicals/DATABASE.md) and
[technicals/NGINX_AND_DOMAINS.md](technicals/NGINX_AND_DOMAINS.md).

The configuration keys `agentic_engine` and `agentic_command` (with
`parent IS NULL`) set the defaults of the virtual agents below.

---

## Virtual agents (`genai_bp`)

Both routes are **user** level, take JSON, and always answer with
`text/event-stream`, using the same `data: {...}` events as streamed
deployments: `chunk`, `error`, and a final
`{"done": true, "success": bool, "returncode": N}`. See
[technicals/VIRTUAL_AGENTS.md](technicals/VIRTUAL_AGENTS.md).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/request_dev_ai_for_app` | user | Virtual Developer: builds a prompt from `shared/<ACTION>_context.md` and runs the agentic engine. After a successful `MODIFY_CODE`, it appends an entry to the deployment's `modification_history` and sets `gitea_branch_url`. |
| POST | `/api/request_ops_ai_for_app` | user | Virtual Operator: same engine. `MODIFY_CODE` is rejected (it belongs to the Developer agent). Recognized actions are `START`, `STOP`, `LOGS`, `PS`, `SPECIFY`, `RESTORE_DATABASE`. With no action, it acts as a Q&A advisor. A successful `START`/`STOP` is billed. |
| GET | `/api/deployments/<int:deployment_id>/logs` | user | Duplicate of the `api_bp` route; never reached (see [below](#duplicate-and-shadowed-routes)). |

Request body (both agents):

| Field | Required | Notes |
|-------|----------|-------|
| `message` | yes | User prompt (`400` if empty). |
| `application_name` | no | Target application. |
| `application_folder` | no | Deployment path. |
| `action_operation` | no | Detected action (for example `MODIFY_CODE`, `START`). Only letters, digits and `_` are kept. |
| `agentic_engine` | no | `shai`, or anything else for Q/Kiro-cli. Default: the `agentic_engine` configuration value, then `AI_ENGINE`. |
| `agentic_command` | no | If set (or configured), runs `deployControlPlan.sh <agentic_command>` instead of the engine. |

```bash
curl -N -b cookies.txt -X POST https://<DOMAIN>/api/request_ops_ai_for_app \
     -H 'Content-Type: application/json' \
     -d '{"message":"Show me the logs","application_name":"my-app","action_operation":"LOGS"}'
```

---

## Billing (`billing_bp`)

`period` query values: `day`, `week`, `month` (default), `previous_month`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/billing/activities?period=&user=` | user (admin sees everyone; `user` filter applies to admins only) | Start/stop activities: `id, username, application, action, started_at, stopped_at, duration_seconds, cost_amount, created_at`. |
| GET | `/api/billing/summary?period=&user=` | user (same rule) | Per user and application: `total_duration_seconds`, `total_cost`. |
| GET | `/api/billing/costs` | admin | `application_id, application_name, cost_per_day` (default 1.0), `updated_at`. |
| PUT | `/api/billing/costs/<int:app_id>` | admin | `{"cost_per_day"}`: creates or updates the cost. |
| GET | `/api/billing/users` | admin | Usernames that have billing activities. |
| GET | `/api/billing/invoices` | user (admin sees all) | `id, username, invoice_month, total_amount, status, payment_date, payment_type, created_at`. |
| GET | `/api/billing/invoices/months?user=` | user (admin may filter by `user`) | `YYYY-MM` months that have billable activity. |
| POST | `/api/billing/invoices/generate` | admin | Creates an `unpaid` invoice for one user and month. |
| GET | `/api/billing/invoices/<int:invoice_id>/pdf` | owner/admin | Returns the invoice as **HTML** (`text/html`), not a PDF. |
| PUT | `/api/billing/invoices/<int:invoice_id>/pay` | owner/admin | Sets `status = 'paid'` and `payment_date`. |
| GET | `/api/billing/debug/<month>` | user | The caller's own activities for `YYYY-MM` and the computed total. |

Cost model: a `START` adds an activity row. The next `STOP` closes it, with
`cost = cost_per_day / 86400 * duration_seconds`.

**POST `/api/billing/invoices/generate`** body: `{"month": "YYYY-MM", "user": "<username>"}`.
Returns `400` if the invoice already exists, the user is unknown, or there is
nothing billable. On success: `{"message", "invoice_id", "total_amount"}`.

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/billing/invoices/generate \
     -H 'Content-Type: application/json' -d '{"month":"2026-10","user":"alice"}'

curl -b cookies.txt https://<DOMAIN>/api/billing/invoices
```

---

## Orchestrator (`orchestrator_bp`)

See [technicals/ORCHESTRATOR.md](technicals/ORCHESTRATOR.md).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orchestrator/user-applications` | user | `[{"name"}]`: the caller's assigned applications. |
| GET | `/api/orchestrator/git-urls` | user | Gitea URLs from the caller's `gitea_branch_url` and `modification_history`. |
| GET | `/api/orchestrator/services` | user | Status of the caller's services. |
| GET | `/api/orchestrator/services/<service_name>` | user | One of the caller's services, or `404`. |
| POST | `/api/orchestrator/services` | admin | Creates a service, picks a server, and runs `deployApp.sh start` over SSH. |
| PUT | `/api/orchestrator/services/<service_name>` | admin | `{"desired_replicas"}`: scaling only. |
| POST | `/api/orchestrator/services/<service_name>/scale` | admin | `{"replicas": N}` (integer, 0 or more). |
| DELETE | `/api/orchestrator/services/<service_name>` | admin | Deletes the caller's service and its instances. |
| POST | `/api/orchestrator/services/multi-user-deploy` | admin | Creates N replica users, then clones and starts the application for each one. |
| POST | `/api/orchestrator/health-check` | admin | Runs a health check on all instances. |
| GET | `/api/orchestrator/nginx/config` | admin | `{"config"}`: the generated upstream configuration. |
| POST | `/api/orchestrator/nginx/reload` | admin | Reloads nginx. |
| POST | `/api/orchestrator/reconcile` | admin | Reconciles every service once. |
| GET | `/api/orchestrator/status` | user | `total_services`, `instance_stats`, `health_stats`, `server_stats`, `reconciliation_running` (platform-wide). |

**POST `/api/orchestrator/services`** body:

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Service name. Also used as the application folder name. |
| `image` | yes | Holds the **git URL**. |
| `desired_replicas` | no | Default 1. One `instances` row is created per replica, on ports from 8000 upward. |
| `ports`, `environment`, `volumes` | no | Stored on the service. |
| `health_check_path` | no | Default `/health`. |

Response: `201` on success. Returns `500` with `error` if no server is
available or the SSH start fails (the service row is already created at that
point).

**POST `/api/orchestrator/services/multi-user-deploy`** body: `name` (must be
an existing application), `image` (git URL), `desired_replicas` (1 to 10),
`environment`, `ports`, `volumes`, `health_check_path`. For each `i` it
creates or reuses user `<name><i>` (lowercase, `_` and spaces replaced with
`-`), assigns the application, clones it, and starts it. Response: `201` with
`total_replicas`, `successful_deploys`, and `created_users` (per-user status).

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/orchestrator/services \
     -H 'Content-Type: application/json' \
     -d '{"name":"my-app","image":"https://github.com/org/my-app.git","desired_replicas":2}'

curl -b cookies.txt -X POST https://<DOMAIN>/api/orchestrator/services/my-app/scale \
     -H 'Content-Type: application/json' -d '{"replicas":3}'
```

---

## Replication sync (`replication_bp`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sync/replicate` | sync-token | Applies one replication event from a peer. Body fields: `event_id`, `timestamp`, `table`, `operation`, `data` (all required). Returns `{"status": "applied"|"skipped", "event_id"}`. |
| GET | `/api/sync/health` | public | `{"status": "healthy", "queue_size", "timestamp"}` |
| GET | `/api/sync/status` | public | `{"queue_size", "peer_count", "peers": [{ip, name, type}]}` |

```bash
curl -X POST https://<DOMAIN>/api/sync/replicate -H "X-Sync-Token: $SYNC_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"event_id":"...","timestamp":"...","table":"users","operation":"INSERT","data":{}}'
```

See [technicals/REPLICATION.md](technicals/REPLICATION.md).

---

## Serverless jobs (`serverless_bp`)

See [SERVERLESS.md](SERVERLESS.md).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/serverless-links` | user | Serverless brick endpoints (applications named `opcp-serverless%`). Returns `{"links": [url...], "endpoints": [{url, username, app_name, status: AVAILABLE|OCCUPIED|UNKNOWN}]}`. |
| POST | `/api/jobs` | user | Submits a job → `201 {"job_id"}`. |
| GET | `/api/jobs?page=&per_page=&status=` | user (own jobs) | Paginated list (`per_page` up to 100). `status` is one of `pending, running, completed, failed, timeout, cancelled`. |
| GET | `/api/jobs/metrics` | session-flag admin | Pending, running and failed counts, average execution time, queue depth, average startup time. Currently returns `403` for everyone. |
| GET | `/api/jobs/<job_id>` | owner | Job status. Pending or running jobs are first refreshed from the remote brick. |
| GET | `/api/jobs/<job_id>/result` | owner | `{"exit_code", "stdout", "stderr", "result"}`. `409` while the job is still running. |
| POST | `/api/jobs/<job_id>/cancel` | owner | Cancels a pending or running job. `409` otherwise. |

The ownership checks also accept `session['is_admin']`, which is never set,
so admins only see their own jobs.

**POST `/api/jobs`** body:

| Field | Required | Notes |
|-------|----------|-------|
| `image` | yes | String. Its registry must be in `SERVERLESS_CONFIG['registry_whitelist']` (`docker.io`, `ghcr.io`, `registry.example.com`), otherwise `403`. |
| `command` | yes | List of strings. |
| `target_link` | yes | Brick URL, usually one from `/api/serverless-links`. |
| `env` | no | Object. |
| `timeout` | no | Integer from 1 to 3600 (default 300). |

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/jobs -H 'Content-Type: application/json' \
     -d '{"image":"docker.io/library/python:3.12","command":["python","-c","print(42)"],"target_link":"https://<DOMAIN>:6133"}'

curl -b cookies.txt https://<DOMAIN>/api/jobs/<job_id>/result
```

---

## Shared GPU (MIG) (`gpu_bp`)

Prefix: `/api/servers/<int:server_id>/gpu`. Every route is
**session-flag admin**. Commands run over SSH as `ubuntu@<server_ip>`. See
[SHARE_GPU_DOCKER.md](SHARE_GPU_DOCKER.md).

> All these routes check `session['is_admin']`, which no login path sets.
> As the code stands, they return `403 Admin access required` to every caller,
> including admins.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/servers/<id>/gpu/profiles` | Runs `nvidia-smi mig -lgip` and returns `{"profiles": [{profile_id, name, memory_mib}]}`. |
| GET | `/api/servers/<id>/gpu/instances` | `{"instances": [{instance_uuid, profile_name, gpu_memory_mb, created_at}]}` from `mig_instances`. |
| POST | `/api/servers/<id>/gpu/instances` | `{"profile_ids": ["9","14",...]}` (1 to 7 string ids). Needs `shared_gpu_enabled`. Runs `sudo nvidia-smi mig -cgi <ids> -C`, then `nvidia-smi -L`, and stores the instances. Returns `201`. |
| DELETE | `/api/servers/<id>/gpu/instances` | Runs `sudo nvidia-smi mig -dci` and then `-dgi`. The rows are deleted only if both commands succeed. |
| PUT | `/api/servers/<id>/gpu/enabled` | `{"enabled": true|false}`. Enabling runs `sudo nvidia-smi -mig 1`, and the flag is set back to false if that fails. |

```bash
curl -b cookies.txt -X PUT https://<DOMAIN>/api/servers/1/gpu/enabled \
     -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -b cookies.txt -X POST https://<DOMAIN>/api/servers/1/gpu/instances \
     -H 'Content-Type: application/json' -d '{"profile_ids":["9","9"]}'
```

---

## Deploy templates (`templates_bp`)

See [LIST_OF_APP_AVAILABLE.md](LIST_OF_APP_AVAILABLE.md).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/templates` | user | `{"templates": [{identifier, app_type, ports, memory_mb, cpu_cores}]}` |
| POST | `/api/templates/<template_id>/deploy` | user | Deploys a template for the caller. |

**POST `/api/templates/<template_id>/deploy`** body (JSON or form):
`{"application_name": "<name>"}`. The name must be 1 to 63 characters from
`[a-z0-9-]`.

| Status | Meaning |
|--------|---------|
| 200 | `{"application_id", "application_name", "access_url", "template_id", "ports"}` |
| 400 | Invalid application name |
| 404 | Unknown template |
| 409 | The caller already has a deployment with that name |
| 502 | Orchestrator deployment failed |

Error bodies are `{"error": "<localized message>"}`.

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/templates/<template_id>/deploy \
     -H 'Content-Type: application/json' -d '{"application_name":"my-blog"}'
```

---

## Setup wizard (`wizard_bp`)

An installer flow. **No route in this blueprint checks for a session.** The
wizard state is kept in the Flask session under `wizard_state`. Steps, in
order: `domain`, `email`, `gitea_version`, `ssl`, `admin_user`, `database`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/wizard/steps` | public | Step payload (see below). |
| GET | `/api/wizard/state` | public | Same payload: the current step, the stored values, and the completion flag. |
| POST | `/api/wizard/step/<step>` | public | Validates and stores one step. `404` for an unknown step, `400` with `errors` when invalid. |
| POST | `/api/wizard/ssl/generate` | public | Automatic certificate generation. Uses `domain`/`email` from the body or the wizard state. Returns `200` on success, `202` while in progress, `400` on failure. |
| POST | `/api/wizard/ssl/upload` | public | Certificate + key upload: file fields `certificate`/`cert` and `private_key`/`key`, or JSON `cert_pem`/`key_pem`. `200` if accepted, `400` if not. |
| POST | `/api/wizard/reset` | public | Clears the wizard state. |

Step payload: `{"steps": [...], "step": "<current>", "values": {...}, "errors": {...}, "complete": bool}`.

Fields per step:

| Step | Fields | Validation |
|------|--------|------------|
| `domain` | `domain` | Hostname, 1 to 253 characters |
| `email` | `email` | Email, 1 to 254 characters, with a dot in the domain part |
| `gitea_version` | `gitea_version` | none |
| `ssl` | for example `ssl_mode` | none (certificates go through `/ssl/*`) |
| `admin_user` | `admin_username`, `admin_password` (and optionally `admin_email`, `admin_first_name`, `admin_last_name`) | Username required, password at least 12 characters |
| `database` | any | none. This is the final step. |

Submitting `database` with valid data calls `ConfigurationWriter.write()`. It
backs up and rewrites the managed keys of `conf/deploy.ini` (`DOMAIN`,
`ADMIN_EMAIL`, `GITEA_VERSION`, `SSL_MODE`). If `admin_password` is present, it
also creates the admin user, or updates its password hash if it already exists.
Response: `200` with `complete: true` and `backup_path`, or `500` with
`failure_type` (`backup` or `write`).

```bash
curl -b w.txt -c w.txt -X POST https://<DOMAIN>/api/wizard/step/domain \
     -H 'Content-Type: application/json' -d '{"domain":"<DOMAIN>"}'
```

---

## Sandbox / demo mode (`sandbox_bp`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sandbox/provision` | user | Creates the demo user and seeds the sample applications. Returns `200` with `credentials` and `apps`, `409` if a sandbox already exists, `500` if seeding fails. |
| POST | `/api/sandbox/reset` | user | Removes the sandbox applications and seeds them again. Always `200`; per-app failures are listed in `failed`. |
| POST | `/api/sandbox/teardown` | user | Stops and removes the applications, the demo user, and the sandbox records. Always `200`. |
| GET | `/api/sandbox/status` | user | `{"exists", "account_type", "apps": [{application_id, application_name, status: running|stopped|failed, access_url}], "poll_interval_seconds": 5}` |

Report payload (provision, reset, teardown):
`{"success", "message", "error_code", "credentials", "apps", "failed"}`, plus
`error` on failure. The actions run synchronously. The dashboard polls
`/api/sandbox/status` while one is running.

```bash
curl -b cookies.txt -X POST https://<DOMAIN>/api/sandbox/provision
curl -b cookies.txt https://<DOMAIN>/api/sandbox/status
```

---

## Duplicate and shadowed routes

- **`GET /api/deployments/<int:deployment_id>/logs`** is defined twice: in
  `api_routes.py` (endpoint `api.api_deployment_logs`) and in
  `genai_routes.py` (endpoint `genai.api_deployment_logs`). The two rules are
  identical, and Werkzeug keeps rules with equal weight in the order they were
  added. `api_bp` is registered before `genai_bp`, so **the `api_routes.py`
  handler always runs**. It checks the path with `is_under_deployments()`;
  the unused `genai` copy uses a hard-coded `/home/<user>/deployments/` prefix
  check.
- `/api/jobs/metrics` and `/api/jobs/<job_id>` do not conflict: Werkzeug
  matches the static segment `metrics` before the `<job_id>` variable.
- `/api/servers/<int:server_id>` (PUT/DELETE, `api_bp`) and
  `/api/servers/<int:server_id>/gpu/...` (`gpu_bp`) are separate rules.
- The page route `GET /servers/<int:server_id>/gpu` (`main_bp`, HTML) and the
  API prefix `/api/servers/<int:server_id>/gpu` are different paths.
