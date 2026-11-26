# Testing

OPCP-explorer has five independent groups of tests. None is wired into a CI pipeline or into
`scripts/controller_cli.py`; each is run by hand.

| Group | Location | Runner | Needs a running platform? |
|-------|----------|--------|---------------------------|
| Platform smoke tests | `scripts/test_platform.py` + `scripts/test_suites.py` | Python script | Yes (HTTPS + PostgreSQL) |
| Component scripts | `scripts/test_orchestrator.py`, `scripts/test_nginx_locations.py`, `scripts/test_backups_history.py` | Python scripts | Database and/or nginx on the host |
| Python unit tests | `tests/*.py` | pytest | No |
| Bash tests for `init_pltf.sh` | `tests/bash/` | bash + fakeroot | No |
| Dashboard JavaScript tests | `tests/js/` | Node (`node --test`) | No |

Related docs: [CLI_REFERENCE.md](../CLI_REFERENCE.md), [VIRTUAL_AGENTS.md](./VIRTUAL_AGENTS.md),
[NGINX_AND_DOMAINS.md](./NGINX_AND_DOMAINS.md), [ORCHESTRATOR.md](./ORCHESTRATOR.md),
[BACKUP_AND_RECOVERY.md](./BACKUP_AND_RECOVERY.md).

## 1. Platform smoke tests (`scripts/test_platform.py`)

An HTTP client that logs in to a running instance and runs test suites against it.
Requires `requests` and `psycopg2-binary` (both in `requirements.txt`); without `psycopg2` the
database suite is skipped.

### Usage

```bash
python3 scripts/test_platform.py --all            # every suite
python3 scripts/test_platform.py auth api         # selected suites
python3 scripts/test_platform.py --all --verbose  # DEBUG output
python3 scripts/test_platform.py --all --json --quiet > results.json
python3 scripts/test_platform.py --all --no-cleanup
python3 scripts/test_platform.py --cleanup-only
```

With no suite, no `--all` and no `--cleanup-only`, the help is printed and the script exits 0.

| Option | Effect |
|--------|--------|
| `suites...` | Suite names (table below). |
| `--all` | Run every suite. |
| `-v`, `--verbose` | Console log level DEBUG. |
| `-q`, `--quiet` | Console log level ERROR (report is still printed). |
| `--json` | Print the report as JSON instead of text. |
| `--no-cleanup` | Do not delete tracked test resources. |
| `--cleanup-only` | Only run cleanup, no login, no tests (currently a no-op, see Cleanup). |
| `--config PATH` | Accepted but currently ignored; configuration comes from environment variables only. |

Exit code: `0` if no test failed or errored, `1` on failures/errors or when login fails,
`130` on Ctrl+C.

### Configuration (environment variables)

| Variable | Default |
|----------|---------|
| `TEST_HOST` / `TEST_PORT` / `TEST_PROTOCOL` | `localhost` / `443` / `https` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `ai_swautomorph` / `swautomorph` / `swautomorph_password` |
| `TEST_USERNAME` | `test_user_<epoch>` |
| `TEST_EMAIL` | `test_<epoch>@example.com` |
| `TEST_PASSWORD` | `test_password_123` |
| `TEST_TIMEOUT` | `30` (seconds per HTTP request) |

`scripts/test_platform.conf.example` lists the same variables; copy it, edit it and `source` it
before running. `scripts/run_tests_example.sh` exports the defaults (installing `requests` and
`psycopg2-binary` if missing) and runs `--all`; the other examples in it are commented out.

TLS verification is disabled for every request, so self-signed certificates work.

### Authentication flow

The runner POSTs `/register` with the test user, sets `users.suspended = FALSE` for that user
directly in PostgreSQL when registration succeeded (new accounts start suspended), then POSTs
`/login`. If login fails, no suite runs.

### Suites

| Name | Class | What it checks |
|------|-------|----------------|
| `auth` | `AuthTests` (in `test_platform.py`) | registration, login + `session` cookie, SSO token request (`POST /sso/token`, only warns when absent), `POST /sso/validate`, `GET /api/auth/status` x3, invalid login rejected |
| `database` | `DatabaseTests` | PostgreSQL connection, `SELECT COUNT(*) FROM users`, tables `users`, `applications`, `servers`, `deployments` exist |
| `api` | `APITests` | `GET /api/auth/status`, `GET /api/platform/status` (200/401/404), unauthenticated `GET /api/applications` |
| `deployment` | `DeploymentTests` | `GET /api/deployments` responds |
| `nginx` | `NginxTests` | `POST /api/nginx/sync` responds |
| `agent`, `billing`, `server`, `replication`, `orchestrator` | placeholders | each returns a single `skip` result ("not yet implemented") |

### Output

- Console log, plus a full DEBUG log in `logs/test_platform_<YYYYmmdd_HHMMSS>.log`.
- The report (text or JSON) is printed to stdout; it is not written to a file. The JSON report
  has `summary` (totals, success rate, duration), `tests` (suite, name, status
  `pass|fail|skip|error`, duration, error, stack trace), `failed_tests`, `slowest_tests`,
  `start_time` and `end_time`.

### Cleanup

Suites register created resources with `CleanupManager`; cleanup runs after the tests unless
`--no-cleanup`. Only resources with a registered delete function are actually removed, so test
users created by `auth` are tracked but not deleted. Tracking is in memory only, so
`--cleanup-only` (a fresh process) has nothing to clean. Remove test users manually if needed:

```sql
DELETE FROM users WHERE username LIKE 'test_user_%';
```

## 2. Component test scripts

Plain scripts (no pytest); they print results and must be run from the repository root with the
virtualenv active.

| Script | What it does | Requirements / side effects |
|--------|--------------|-----------------------------|
| `scripts/test_orchestrator.py` | Builds the Flask app, then calls `orchestrator.create_service(...)`, `get_service_status()` and `generate_nginx_config()` from `src/orchestrator.py`. | Database reachable. Errors are printed, not raised. |
| `scripts/test_nginx_locations.py` | Checks `generate_location_block()` output (HTTP fallback port = HTTPS port - 1, HTTPS sidecar upstream with `proxy_ssl_verify off`, path preserved: no trailing `/` on `proxy_pass`), then inserts and removes a real location block via `insert_location_block()` / `remove_location_block()`. | Write access to `/etc/nginx/sites-available/<PLTF_FOLDER>` (run as a user allowed to edit nginx). Exits 1 on an assertion error. |
| `scripts/test_backups_history.py` | Checks the `deployments.backups_history` JSONB column and its GIN index `idx_deployments_backups_history`, appends a sample backup entry to the first deployment, reads it back and runs JSONB queries. | Run `migration/add_backups_history_to_deployments.sql` first. Writes a test entry that is not removed. |

```bash
python3 scripts/test_orchestrator.py
python3 scripts/test_nginx_locations.py
python3 scripts/test_backups_history.py
```

## 3. Python unit tests (`tests/*.py`)

pytest tests that need neither a database nor a running platform. pytest is not listed in
`requirements.txt`; install it in the virtualenv first.

```bash
pip install pytest
python3 -m pytest tests -q
```

| File | What it checks |
|------|----------------|
| `tests/test_shai_subcommand_bug_condition.py` | Parses `src/routes/genai_routes.py` with `ast`; both `shai` branches must build `[engine_cmd, '-p', l_prompt]` (no `chat`, no `--trust-all-tools`). |
| `tests/test_shai_subcommand_preservation.py` | Same AST approach: the qchat/Kiro branches keep `[engine_cmd, 'chat', '--trust-all-tools', l_prompt]`, the `agentic_command` branches still call `deployControlPlan.sh`, a missing `shai` binary returns before `subprocess.Popen`. |

The current tests do not use Hypothesis (a `.hypothesis/` cache may exist from earlier runs).
Specs behind these tests live in `.kiro/specs/shai-cli-subcommand-fix/`.

Known state: `test_baseline_chat_trust_all_tools_occurrence_count` in the preservation file
asserts the pre-fix baseline (4 occurrences of `'chat', '--trust-all-tools'`), so it fails on the
fixed code (2 occurrences). The other 12 tests pass.

## 4. Bash tests (`tests/bash/`)

Unit, property-based and integration tests for the ownership-restore logic of `init_pltf.sh`
(`restore_invoking_user_ownership`). The harnesses source the real script behind its source guard,
so the installer body never runs, and use `fakeroot` to simulate `EUID 0` and `chown`, so no real
root access is needed.

```bash
sudo apt-get install fakeroot   # once
bash tests/bash/test_init_ownership.sh
bash tests/bash/test_init_preservation.sh
bash tests/bash/test_init_ownership_unit.sh
bash tests/bash/test_init_ownership_property.sh
bash tests/bash/test_init_ownership_integration.sh
```

File-by-file details: [tests/bash/README.md](../../tests/bash/README.md).

## 5. Dashboard JavaScript tests (`tests/js/`)

jsdom-based tests run with Node's built-in runner (Node 22 tested). Dev dependencies: `jsdom`
and `fast-check` (property tests).

```bash
cd tests/js
npm install
npm test        # = node --test, runs every *.test.js
```

They cover the sortable table headers (`makeSortable` and its helpers: `detectColumnType`,
`getCellText`, `buildComparator`, `applySort`, `resolveHeaders`, wiring/integration and smoke
checks) and the running-app highlight colours (`dashboard-running-app-highlight.test.js`).
`harness.js` loads `templates/dashboard_functions.js`; note that the dashboard page itself loads
`static/js/dashboard_functions.js`, a separate copy.

Details: [tests/js/README.md](../../tests/js/README.md).
