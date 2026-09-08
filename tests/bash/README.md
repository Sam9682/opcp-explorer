# Bash tests — `stop-command-not-stopping-fix`

Tests for the bugfix spec `stop-command-not-stopping-fix`. They exercise the
real `stop_services` / `backup_database` functions from `deployControlPlan.sh`.

## Files

- `stop_services_harness.sh` — extracts the real `stop_services` and
  `backup_database` function bodies from `deployControlPlan.sh` (by name, via
  brace counting) and runs `stop_services` under `set -e` in a sandbox. All
  external commands (`pg_isready`, `pg_dump`, `aws`, ...) and the
  service-stopping functions are stubbed. It records which stop commands ran
  and prints a `PROBE` line.

  Parameters (env vars):
  - `MODE` = `locally` | `docker` | `default` → sets `LOCAL_MODE`
  - `FAIL_MODE` = `pg_isready` | `pg_dump` | `none` → how `backup_database` fails

- `test_stop_backup_failure.sh` — **Property 1 (Bug Condition)** test. Scoped
  property-based enumeration over `MODE × FAIL_MODE` for the bug-condition
  input space (`backup_database` exit code ≠ 0). Asserts the Expected Behavior:
  the script does not abort early, all applicable stop commands run, and a
  warning is logged.

## Running

```bash
bash tests/bash/test_stop_backup_failure.sh
```

## Bug condition exploration — result (Task 1)

Run on the **UNFIXED** `deployControlPlan.sh`: the test **FAILS**, which is the
expected/success outcome for an exploration test — it proves the bug exists.

### Counterexamples (6/6 bug-condition cases fail)

For every `MODE ∈ {locally, docker, default}` and every backup-failure path
`FAIL_MODE ∈ {pg_isready, pg_dump}`:

```
PROBE result=ABORTED_EARLY flask=0 nginx=0 docker=0 gitea=0 warning=0 (child_exit=1)
```

- **Root cause confirmed:** inside `stop_services()`, `backup_database` is
  called as a bare statement. With `set -e` active (line 6), a non-zero return
  from `backup_database` (failed `pg_isready` connection test, or failed
  complete `pg_dump`) aborts the whole script **before** any
  `stop_flask_service` / `stop_nginx_service` / `stop_docker_services` /
  `confirm_gitea_stop` runs. No stop command is recorded and no warning is
  logged.

### Control case (sanity, not part of the bug condition)

With `FAIL_MODE=none` (backup succeeds) the harness reports `COMPLETED` and the
correct mode-specific stop commands run (`locally` → flask/nginx/gitea,
`docker` → docker, `default` → all four). This proves the harness can produce
passing probes and is genuinely discriminating.

The fix (Task 3) makes the pre-stop backup best-effort
(`backup_database || echo -e "  ⚠️ ..."`); after that this same test is expected
to PASS.
