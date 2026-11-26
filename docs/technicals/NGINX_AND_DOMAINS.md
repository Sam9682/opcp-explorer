# Nginx, Domains and SSL

The host nginx is the single HTTPS entry point of OPCP-explorer. It serves:

- the platform UI/API (Flask/gunicorn on `127.0.0.1:5000`);
- Gitea under `/gitea/`;
- one **dynamic location per user application**: `https://<DOMAIN>/<username>/<app_name>/`;
- optional **secondary domains**, each proxied to its own backend.

Related docs: [../DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md), [../INIT_PLATFORM.md](../INIT_PLATFORM.md), [ORCHESTRATOR.md](ORCHESTRATOR.md), [../CLI_REFERENCE.md](../CLI_REFERENCE.md).

| Component | File |
|---|---|
| Base site generation, ModSecurity, startup sync | `deployControlPlan.sh` (`configure_nginx`, `create_nginx_config`, `setup_modsecurity_config`, `sync_nginx_locations`) |
| ModSecurity config writer | `setup_modsecurity_config.sh` |
| Dynamic location management | `src/nginx_manager.py` |
| Sync script | `scripts/sync_nginx_locations.py` |
| Tests | `scripts/test_nginx_locations.py` |
| API | `POST /api/nginx/sync`, `POST /api/nginx/update-deployment` (`src/routes/api_routes.py`) |

---

## 1. Base site configuration

On `start` / `restart` in `locally` mode, `deployControlPlan.sh` runs `configure_nginx`:

1. `setup_modsecurity_config` and `check_and_enable_modsecurity` (see [§5](#5-modsecurity-waf));
2. `create_nginx_config` — writes the site file from scratch;
3. `enable_nginx_site` — moves it to `/etc/nginx/sites-available/<NAME_OF_APPLICATION>` and symlinks it into `sites-enabled/`;
4. `test_and_reload_nginx` — `nginx -t` then reload (or start nginx);

then `configure_firewall` (`ufw allow` 80, 443, 3000, 53) and, as the **last step**, `sync_nginx_locations` (also run at the end of a `docker`-mode start). `NAME_OF_APPLICATION` is `PLTF_NAME` from `conf/deploy.ini` (default `agentic-ai-plateform`).

Because the base file is regenerated on every start, all dynamic locations are wiped and then re-created by the final sync step. A sync failure only prints a warning; the deploy continues.

Generated file, in order:

```nginx
# 1. one server block per SECONDARY_DOMAINS entry (see §4)

# 2. HTTP -> HTTPS redirect for the main domain
server {
    listen 80;
    server_name <DOMAIN> www.<DOMAIN>;
    return 301 https://$host$request_uri;
}

# 3. Main HTTPS server
server {
    listen 443 ssl;
    server_name <DOMAIN> www.<DOMAIN>;
    ssl_certificate     /home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/ssl/<DOMAIN>/fullchain_domain.crt;
    ssl_certificate_key /home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/ssl/<DOMAIN>/privateKey_domain.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    modsecurity on;                                         # only if the module is available
    modsecurity_rules_file /etc/nginx/modsec/main.conf;

    # dynamic user/app locations are inserted here (see §3)

    location / { proxy_pass http://localhost:5000; ... }    # FLASK_PORT, default 5000
    location /gitea/ { proxy_pass http://localhost:3000/; ... }  # GITEA_PORT, default 3000; websockets, 300 s timeouts
}
```

`DOMAIN`, `PLTF_FOLDER`, `LINUX_USER_INSTALLATION` and `SECONDARY_DOMAINS` come from `conf/deploy.ini` (see `conf/deploy.ini.template`).

---

## 2. SSL certificates

nginx expects one folder per domain inside the platform folder:

```
/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/ssl/
├── <DOMAIN>/
│   ├── fullchain_domain.crt      # certificate + chain
│   └── privateKey_domain.key     # private key
└── <secondary-domain>/           # one per SECONDARY_DOMAINS entry
    ├── fullchain_domain.crt
    └── privateKey_domain.key
```

`init_pltf.sh` creates `ssl/<DOMAIN>/` and reminds you to drop both files there. Certificates are not generated or renewed by the platform. For example, with Let's Encrypt:

```bash
sudo certbot certonly --standalone -d <DOMAIN> -d www.<DOMAIN>
cp /etc/letsencrypt/live/<DOMAIN>/fullchain.pem ssl/<DOMAIN>/fullchain_domain.crt
cp /etc/letsencrypt/live/<DOMAIN>/privkey.pem   ssl/<DOMAIN>/privateKey_domain.key
chmod 644 ssl/<DOMAIN>/fullchain_domain.crt && chmod 600 ssl/<DOMAIN>/privateKey_domain.key
python3 scripts/controller_cli.py restart
```

Note: `scripts/generate_ssl.sh` and `scripts/setup_letsencrypt.sh` write into `ssl/` directly (not `ssl/<DOMAIN>/`) with other file names, so their output is not picked up by the nginx config as is.

---

## 3. Dynamic user/application locations

Each assigned application gets a path on the main domain:

```
https://<DOMAIN>/<username>/<app_name>/
```

The path uses the **username** (`users.username`) and the **application name** (`applications.name`), not ids.

### Generated block

`generate_location_block()` in `src/nginx_manager.py`:

```nginx
    # Dynamic location for user alice - my-app
    location /alice/my-app/ {
        proxy_pass https://<DOMAIN>:6137/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_ssl_verify off;          # app sidecars use self-signed certs
        proxy_ssl_server_name on;

        proxy_redirect https://<DOMAIN>:6137/ /alice/my-app/;
        proxy_redirect / /alice/my-app/;

        proxy_http_version 1.1;        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        sub_filter 'href="/' 'href="/alice/my-app/';
        sub_filter 'src="/' 'src="/alice/my-app/';
        sub_filter_once off;
        sub_filter_types text/css text/javascript application/javascript;
    }
```

- `proxy_pass` ends with `/`, so nginx **strips** the `/<username>/<app_name>/` prefix before forwarding; the app sees requests at `/`.
- `proxy_redirect` and `sub_filter` re-add the prefix to redirects and to absolute `href="/…"` / `src="/…"` in HTML, CSS and JS.
- The `# Dynamic location for user <user> - <app>` comment is the marker used to find and remove the block later (brace-balanced removal).

### Upstream selection

The stored URL in `user_applications.url` is `https://<DOMAIN>:<https_port>`. Because ports can drift after a redeploy, the real ports are read from Docker first (`discover_running_ports()`, via `sudo docker ps`):

- a container is mapped to `(username, app)` through its compose label `com.docker.compose.project.working_dir` = `/home/<linux_user>/deployments/<username>/<app>`;
- frontend / nginx sidecar containers (name contains `-nginx-`, `-frontend-` or `frontend-component`) → **https** = host port mapped to container port 443;
- backend containers (`-app-`, `-backend-` or `backend-component`) → **http** = first published host port.

Upstream, in order of preference:

1. `https://<host>:<sidecar https port>` — the app's own nginx sidecar (keeps the app's internal routing);
2. `http://<host>:<backend http port>`;
3. derived from the stored URL: `http://<host>:<stored port - 1>`.

During a full sync, if the running HTTPS port differs from the one in the stored URL, `user_applications.url`, `http_port` and `https_port` are updated to match the running container.

### Where blocks are written

- File: `/etc/nginx/sites-available/<PLTF_FOLDER>` (`NGINX_CONF_FILE = PLTF_FOLDER`), symlinked into `sites-enabled/` if missing.
- Blocks are inserted just before the first line equal to `    location / {` in that file.
- Each write: temp file `/tmp/<PLTF_FOLDER>` → `sudo mv` → `sudo chmod 644` → `sudo nginx -t` → `sudo systemctl reload nginx`. If `nginx -t` fails the reload is skipped (the broken file stays in place until the next successful write or restart).

The Flask user therefore needs passwordless `sudo` for `docker`, `mv`, `chmod`, `ln`, `nginx` and `systemctl`.

### When locations change

| Trigger | Effect |
|---|---|
| `POST /api/users/<user_id>/applications` (assign app) | Insert/replace block |
| `DELETE /api/users/<user_id>/applications` (unassign) | Remove block |
| `POST /api/deployments` with clone action, after a successful clone | Insert/replace block from the stored URL |
| Template deploy (`src/template_deploy.py`, e.g. `controller_cli.py templates deploy`) | Insert block; failure rolls the deploy back |
| Sandbox teardown/reset (`src/sandbox_manager.py`) | Remove block |
| `POST /api/nginx/update-deployment` (admin; body `user_id`, `app_name`, `deployment_url`, `user_appli_url`) | Insert/replace one block |
| `POST /api/nginx/sync` (admin) | Full rebuild from DB |
| Platform start/restart (`sync_nginx_locations` in `deployControlPlan.sh`) | Full rebuild from DB |
| CLI `update-nginx-locations` or `scripts/sync_nginx_locations.py` | Full rebuild from DB |

A full rebuild (`sync_all_locations()`) removes every dynamic block and regenerates one per row of:

```sql
SELECT u.username, a.name, ua.url
FROM user_applications ua
JOIN applications a ON ua.application_id = a.id
JOIN users u ON ua.user_id = u.id
WHERE ua.url IS NOT NULL AND ua.url != '';
```

(if that query returns no rows, the file is left untouched).

```bash
python3 scripts/controller_cli.py update-nginx-locations
# or
python3 scripts/sync_nginx_locations.py      # loads .env, exit code 0/1
```

Admins can also read/reload the orchestrator's generated upstream config through `GET /api/orchestrator/nginx/config` and `POST /api/orchestrator/nginx/reload` (see [ORCHESTRATOR.md](ORCHESTRATOR.md)).

---

## 4. Secondary domains

`SECONDARY_DOMAINS` in `conf/deploy.ini` adds extra HTTPS virtual hosts in front of the main server block:

```ini
# domain:server_names:proxy_pass, comma-separated
SECONDARY_DOMAINS=example.org:example.org www.example.org:https://<DOMAIN>:6137,api.example.net:api.example.net:http://localhost:8000
```

- Entries are split on `,`; each entry on `:` into `domain`, `server_names`, `proxy_pass` (everything after the second `:` is kept, so URLs with ports work).
- `domain` selects the certificate folder `ssl/<domain>/` (same file names as the main domain).
- `server_names` is a space-separated list used as `server_name`.
- Entries with an empty `domain` or `server_names` are ignored.

Each entry produces:

```nginx
server {
    listen 443 ssl;
    server_name <server_names>;
    ssl_certificate     /home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/ssl/<domain>/fullchain_domain.crt;
    ssl_certificate_key /home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/ssl/<domain>/privateKey_domain.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass <proxy_pass>;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Secondary domains get no port-80 redirect and no ModSecurity. Changes take effect on the next `restart` (the file is regenerated).

The example in `conf/deploy.ini.template` has no valid URL as its third field; follow the format above.

---

## 5. ModSecurity (WAF)

- **Install** (`install_nginx_with_modsecurity`, only when `nginx` is not installed yet): installs `nginx` and `libmodsecurity3` (fallback `libmodsecurity-dev modsecurity-crs`), creates `MODSECURITY_CONF_DIR` (default `/etc/nginx/modsec`) and clones the OWASP CRS into `MODSECURITY_RULES_DIR` (default `/usr/share/modsecurity-crs`) at `OWASP_CRS_VERSION` (default `v3.3.5`) if missing.
- **Config** (`setup_modsecurity_config.sh`): writes `<conf dir>/modsecurity.conf` (`SecRuleEngine On`, request body limit 13 MB, JSON/XML body processors, audit log `/var/log/nginx/modsec_audit.log` for relevant 4xx/5xx except 404) and `<conf dir>/main.conf` (includes `modsecurity.conf`, CRS `crs-setup.conf` and `rules/*.conf`), and copies `crs-setup.conf.example` to `crs-setup.conf`.
- **Enable**: if `ngx_http_modsecurity_module.so` exists in `/usr/lib/nginx/modules/` or `/etc/nginx/modules/`, `load_module modules/ngx_http_modsecurity_module.so;` is prepended to `/etc/nginx/nginx.conf` and `modsecurity on;` is added to the **main domain** server block. Otherwise a warning is printed and nginx runs as a plain reverse proxy.

The dynamic user/app locations live in the main server block, so they are covered by the WAF when it is enabled.

---

## 6. Troubleshooting

```bash
sudo nginx -t                                              # syntax check
cat /etc/nginx/sites-available/<PLTF_FOLDER>               # current config incl. dynamic blocks
grep -n "Dynamic location for user" /etc/nginx/sites-available/<PLTF_FOLDER>
python3 scripts/controller_cli.py update-nginx-locations   # rebuild all locations
sudo docker ps --format '{{.Names}}  {{.Ports}}'          # real app ports
tail -f /var/log/nginx/error.log /var/log/nginx/modsec_audit.log
tail -f logs/api_routes.log
```

| Symptom | Likely cause |
|---|---|
| 502 on `/<user>/<app>/` | App container down, or port drift: run a sync so ports are re-read from Docker. |
| App loads but assets 404 | App uses absolute paths not covered by `sub_filter` (e.g. built in JS); configure the app with a base path or relative URLs. |
| Location missing after restart | The start-time sync failed (warning in the deploy output); run `update-nginx-locations`. |
| `nginx -t` fails on cert | Missing `ssl/<domain>/fullchain_domain.crt` or `privateKey_domain.key`. |
| Requests blocked (403) | ModSecurity CRS rule; check `modsec_audit.log`. |

---

## 7. Known issues

- `deployControlPlan.sh` writes the site as `sites-available/<NAME_OF_APPLICATION>` (= `PLTF_NAME`) while `nginx_manager.py` edits `sites-available/<PLTF_FOLDER>`. They only match when `PLTF_NAME == PLTF_FOLDER` (true for the defaults).
- With `SECONDARY_DOMAINS` set, the first `    location / {` in the file belongs to a secondary-domain server block, so dynamic locations are inserted there instead of in the main domain block.
- `POST /api/nginx/update-deployment` passes the raw DB row (a tuple) as the username, producing a wrong location path. The dashboard button calling it also references an undefined `targetUrl` variable.
- `deployControlPlan.sh`'s `setup_modsecurity_config` only `source`s `setup_modsecurity_config.sh`, which redefines the function without running it; the ModSecurity config files are therefore written only when the function is called a second time (as in `install_nginx_with_modsecurity`).
- `scripts/test_nginx_locations.py` is out of date: it passes a numeric user id as the username and asserts that `proxy_pass` has no trailing `/` (path preserved), whereas the code strips the prefix.
