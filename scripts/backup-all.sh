#!/bin/sh
# Runs backup-postgres.sh, backup-vault.sh, and backup-recordings.sh with
# the same compose-file/output-dir arguments. Suitable for a single cron
# entry rather than scheduling the three separately.
#
# Usage:
#   ./scripts/backup-all.sh [compose-file] [output-dir]
#
# Example crontab entry (daily at 2am, keeping the default ./backups dir):
#   0 2 * * * cd /path/to/guac-access-suite && ./scripts/backup-all.sh >> /var/log/guac-backup.log 2>&1
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

"$SCRIPT_DIR/backup-postgres.sh" "$@"
"$SCRIPT_DIR/backup-vault.sh" "$@"
"$SCRIPT_DIR/backup-recordings.sh" "$@"

echo "All three backups complete."
