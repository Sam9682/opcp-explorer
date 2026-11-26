#!/usr/bin/env bash
# Write the SMTP settings used by src/email_service.py (password reset, email 2FA)
# into the project's .env file. Existing SMTP_* lines are replaced, other lines are kept.
#
# Usage:
#   scripts/set_smtp.sh            # prompts for the mailbox password
#   scripts/set_smtp.sh --test     # same, then sends a test email to SMTP_USER
#
# Any value can be overridden from the environment, e.g.:
#   SMTP_FROM_NAME="OPCP Explorer" scripts/set_smtp.sh
#   SMTP_PASSWORD='...' scripts/set_smtp.sh   (non-interactive)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

# OVHcloud mail: port 587 + STARTTLS. Port 465 (implicit SSL) is NOT supported
# by email_service.py, which uses smtplib.SMTP + starttls().
SMTP_HOST="${SMTP_HOST:-ssl0.ovh.net}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USE_TLS="${SMTP_USE_TLS:-true}"
SMTP_USER="${SMTP_USER:-slepetre@opcp-psmc.com}"       # full address, not the short login
SMTP_FROM_EMAIL="${SMTP_FROM_EMAIL:-$SMTP_USER}"       # must be the mailbox or one of its aliases
SMTP_FROM_NAME="${SMTP_FROM_NAME:-AI-SwAutoMorph}"

if [[ -z "${SMTP_PASSWORD:-}" ]]; then
    read -r -s -p "Mailbox password for $SMTP_USER: " SMTP_PASSWORD
    echo
fi
[[ -n "$SMTP_PASSWORD" ]] || { echo "Error: empty password" >&2; exit 1; }

# Single-quote a value for python-dotenv (escape backslashes and single quotes)
quote() {
    local v="${1//\\/\\\\}"
    printf "'%s'" "${v//\'/\\\'}"
}

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -vE '^[[:space:]]*(export[[:space:]]+)?SMTP_[A-Z_]+=' "$ENV_FILE" > "$tmp" || true
{
    echo "SMTP_HOST=$(quote "$SMTP_HOST")"
    echo "SMTP_PORT=$(quote "$SMTP_PORT")"
    echo "SMTP_USE_TLS=$(quote "$SMTP_USE_TLS")"
    echo "SMTP_USER=$(quote "$SMTP_USER")"
    echo "SMTP_PASSWORD=$(quote "$SMTP_PASSWORD")"
    echo "SMTP_FROM_EMAIL=$(quote "$SMTP_FROM_EMAIL")"
    echo "SMTP_FROM_NAME=$(quote "$SMTP_FROM_NAME")"
} >> "$tmp"
cat "$tmp" > "$ENV_FILE"

echo "SMTP settings written to $ENV_FILE ($SMTP_USER via $SMTP_HOST:$SMTP_PORT, STARTTLS=$SMTP_USE_TLS)"

if [[ "${1:-}" == "--test" ]]; then
    echo "Sending test email to $SMTP_USER ..."
    (cd "$ROOT_DIR" && python3 - <<'PY'
from dotenv import load_dotenv
load_dotenv('.env', override=True)
import sys
sys.path.insert(0, 'src')
from email_service import send_email
import os
ok = send_email(os.environ['SMTP_USER'], 'SMTP test', '<p>SMTP configuration works.</p>')
print('OK' if ok else 'FAILED (see log output above)')
sys.exit(0 if ok else 1)
PY
    )
fi

echo "Restart the application so it reloads .env."
