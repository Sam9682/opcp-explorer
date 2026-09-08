#!/usr/bin/env bash
# Preservation / Property 2 test for the "stop-command-not-stopping-fix"
# bugfix spec.
#
#   Property 2 (Preservation -> Non-Failing Paths Unchanged):
#     FOR ALL X WHERE NOT isBugCondition(X)      # backup succeeds, OR called from a non-stop path
#       stop_services(X)      SHALL equal the original behaviour, AND
#       backup_database (standalone) SHALL surface its original exit code.
#
# Validates: Requirements 3.1, 3.2, 3.3, 3.4
#
# This encodes the baseline observed on the UNFIXED deployControlPlan.sh
# (observation-first methodology). These tests MUST PASS on the unfixed code -
# that is what pins down the behaviour the fix must preserve. After the fix
# (task 3) they must still pass, proving no regression.
#
# Observed baseline on UNFIXED code (succeeding backup, FAIL_MODE=none):
#   MODE=locally -> seq=backup,flask,nginx,gitea      (backup first, then stop)
#   MODE=docker  -> seq=backup,docker
#   MODE=default -> seq=backup,flask,nginx,gitea,docker
#   * no warning is logged on the success path (warning=0)
#   * the sequence is invariant to --keep-gitea-running (KEEP_GITEA true|false)
#   backup_database standalone exit code:
#   FAIL_MODE=none -> 0 ; FAIL_MODE=pg_isready -> 1 ; FAIL_MODE=pg_dump -> 1
#
# EXPECTED OUTCOME ON UNFIXED CODE: all tests PASS.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_SCRIPT="$REPO_ROOT/deployControlPlan.sh"
HARNESS="$SCRIPT_DIR/stop_services_harness.sh"

# The expected (baseline) ordered stop sequence for each mode when the pre-stop
# backup SUCCEEDS. "backup" marks the pre-stop database backup completing before
# the mode-specific stop commands (Requirement 3.1 ordering: backup, then stop;
# Requirement 3.2 mode-specific commands).
expected_seq_for_mode() {
    case "$1" in
        locally) echo "backup,flask,nginx,gitea" ;;
        docker)  echo "backup,docker" ;;
        default) echo "backup,flask,nginx,gitea,docker" ;;
    esac
}

total=0
failed=0
declare -a FAILURES=()

pass() { echo "PASS  $1"; }
fail() { failed=$((failed + 1)); echo "FAIL  $1 -> $2"; FAILURES+=("$1: $2"); }

# ---------------------------------------------------------------------------
# Part A - Property-based preservation over (LOCAL_MODE, backup_exit_code=0,
#          keep_gitea_running).
#
# The bug condition is: command="stop" AND backup_exit_code != 0. Here we fix
# backup_exit_code = 0 (FAIL_MODE=none), so every generated tuple lies OUTSIDE
# the bug condition and must exhibit the preserved baseline behaviour.
#
# Input domain generated:
#   LOCAL_MODE        in { locally, docker, default }
#   backup_exit_code  = 0                       (FAIL_MODE=none)
#   keep_gitea_running in { true, false }
# ---------------------------------------------------------------------------
MODES=(locally docker default)
KEEPS=(true false)

echo "--- Property 2A: successful-backup stop sequence preserved (3.1, 3.2, 3.3) ---"
for MODE in "${MODES[@]}"; do
    for KEEP in "${KEEPS[@]}"; do
        total=$((total + 1))
        label="MODE=$MODE backup_exit=0 keep_gitea=$KEEP"

        probe="$(MODE="$MODE" FAIL_MODE=none KEEP_GITEA="$KEEP" bash "$HARNESS" \
                 | grep '^PROBE ' | tail -n1)"

        result="$(sed -n 's/.*result=\([A-Z_]*\).*/\1/p' <<<"$probe")"
        seq="$(sed -n 's/.* seq=\([^ ]*\).*/\1/p' <<<"$probe")"
        warning="$(sed -n 's/.* warning=\([0-9]\).*/\1/p' <<<"$probe")"
        backup="$(sed -n 's/.* backup=\([0-9]\).*/\1/p' <<<"$probe")"

        want="$(expected_seq_for_mode "$MODE")"

        if [ "$result" != "COMPLETED" ]; then
            fail "$label" "expected COMPLETED but got result=$result (probe: $probe)"
            continue
        fi
        # 3.1: backup is created (backup marker present) and precedes stop cmds.
        if [ "${backup:-0}" != "1" ]; then
            fail "$label" "successful backup not recorded (backup=$backup)"
            continue
        fi
        # 3.1 + 3.2 + 3.3: exact ordered mode-specific sequence preserved.
        if [ "$seq" != "$want" ]; then
            fail "$label" "expected sequence [$want] but recorded [$seq]"
            continue
        fi
        # 3.1: no warning on the success path (fix must not add a warning here).
        if [ "${warning:-0}" != "0" ]; then
            fail "$label" "unexpected warning logged on successful-backup path"
            continue
        fi
        pass "$label -> seq=$seq"
    done
done

# ---------------------------------------------------------------------------
# Part B - Standalone backup_db exit code preserved (Requirement 3.4).
#
# The `backup_db` / `--backup_db` command calls `backup_database` directly. Its
# exit code must be surfaced unchanged: 0 on success, 1 on either failure path.
# We extract and invoke the REAL backup_database exactly as that command does.
# ---------------------------------------------------------------------------
echo ""
echo "--- Property 2B: standalone backup_db surfaces backup_database exit code (3.4) ---"

extract_func() {
    local fname="$1" file="$2"
    awk -v fn="$fname" '
        $0 ~ "^"fn"\\(\\) \\{" { capture=1; depth=0 }
        capture {
            print
            n = gsub(/\{/, "{"); depth += n
            m = gsub(/\}/, "}"); depth -= m
            if (depth <= 0) { exit }
        }
    ' "$file"
}

run_backup_db_exitcode() {
    # Mirrors the `"backup_db"|"--backup_db")` dispatch: invoke backup_database
    # and report its natural exit code. External commands are stubbed.
    local fail_mode="$1"
    local sandbox; sandbox="$(mktemp -d)"
    extract_func "backup_database" "$TARGET_SCRIPT" > "$sandbox/fn.sh"
    local code
    code=$(FAIL_MODE="$fail_mode" SANDBOX="$sandbox" bash <<'CHILD'
cd "$SANDBOX"
pg_isready() { [ "$FAIL_MODE" = "pg_isready" ] && return 1; return 0; }
pg_dump()    { [ "$FAIL_MODE" = "pg_dump" ] && return 1; return 0; }
aws()        { return 0; }
get_server_ip() { echo "127.0.0.1"; }
NAME_OF_APPLICATION="opcp-explorer"; S3_BUCKET_NAME="test-bucket"; OK="OK"; ERROR="ERR"
# shellcheck disable=SC1090
source "$SANDBOX/fn.sh"
backup_database >/dev/null 2>&1
echo $?
CHILD
)
    rm -rf "$sandbox"
    echo "$code"
}

# (fail_mode, expected exit code) - baseline observed on UNFIXED code.
declare -a CASES=("none:0" "pg_isready:1" "pg_dump:1")
for c in "${CASES[@]}"; do
    total=$((total + 1))
    fail_mode="${c%%:*}"
    want_code="${c##*:}"
    label="backup_db FAIL_MODE=$fail_mode"
    got_code="$(run_backup_db_exitcode "$fail_mode")"
    if [ "$got_code" = "$want_code" ]; then
        pass "$label -> exit=$got_code"
    else
        fail "$label" "expected exit=$want_code but got exit=$got_code"
    fi
done

echo ""
echo "=============================================================="
echo "Property 2 (Preservation -> Non-Failing Paths Unchanged)"
echo "Ran $total cases, $failed failed."
if [ "$failed" -ne 0 ]; then
    echo ""
    echo "FAILURES:"
    for f in "${FAILURES[@]}"; do
        echo "  - $f"
    done
    echo "=============================================================="
    exit 1
fi
echo "All cases preserved the baseline behaviour."
echo "=============================================================="
exit 0
