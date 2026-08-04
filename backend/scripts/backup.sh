#!/usr/bin/env bash
# Back up the production D1 database (spec 13: "a season of data is not
# reproducible").
#
# Writes a timestamped .sql dump OUTSIDE the repo by default. That is
# deliberate: the dump contains the roster, device hashes, and every vote, and
# a backup that lives in a git working tree eventually gets committed.
#
# Usage:
#   backend/scripts/backup.sh                 # back up production
#   BACKUP_DIR=/somewhere backend/scripts/backup.sh
#   KEEP=60 backend/scripts/backup.sh         # change retention
#
# Restore is documented at the bottom of this file. Read it BEFORE you need it.

set -euo pipefail

DB_NAME="${DB_NAME:-lockerroom}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/lockerroom-backups}"
KEEP="${KEEP:-30}"

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_DIR"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql"

echo "Exporting ${DB_NAME} (remote) -> ${OUT}"
npx wrangler d1 export "$DB_NAME" --remote --output="$OUT"

# A backup nobody checked is not a backup. Fail loudly rather than leave a
# truncated or empty file sitting there looking like insurance.
if [ ! -s "$OUT" ]; then
  echo "FAILED: export produced an empty file" >&2
  rm -f "$OUT"
  exit 1
fi

for table in users devices tracks plays votes settings; do
  if ! grep -qi "CREATE TABLE.*\b${table}\b" "$OUT"; then
    echo "FAILED: '${table}' missing from the dump - not a usable backup" >&2
    exit 1
  fi
done

BYTES=$(wc -c < "$OUT" | tr -d ' ')
INSERTS=$(grep -c '^INSERT INTO' "$OUT" || true)
echo "OK: ${BYTES} bytes, ${INSERTS} INSERT statements"

# Retention. Only ever touches files this script created, in this directory,
# matching this database's name - never a blanket delete.
COUNT=$(ls -1 "$BACKUP_DIR"/${DB_NAME}-*.sql 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/${DB_NAME}-*.sql | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "  pruning $(basename "$old")"
    rm -f "$old"
  done
fi

echo "Done. ${BACKUP_DIR} holds $(ls -1 "$BACKUP_DIR"/${DB_NAME}-*.sql 2>/dev/null | wc -l | tr -d ' ') backup(s)."

# ---------------------------------------------------------------------------
# RESTORE
#
# Test this against --local BEFORE you ever need it in anger.
#
#   # 1. Practice locally first. This wipes the local DB, not production.
#   npx wrangler d1 execute lockerroom --local --file=/path/to/backup.sql
#
#   # 2. For production, D1 Time Travel is the FIRST thing to reach for - it
#   #    restores to a point in time within the last 30 days without needing
#   #    this file at all, and it is far less error-prone:
#   npx wrangler d1 time-travel info lockerroom
#   npx wrangler d1 time-travel restore lockerroom --timestamp=<ISO8601>
#
#   # 3. Only if the damage is older than 30 days, or Time Travel is not
#   #    enough, import this dump. The export contains CREATE TABLE, so drop
#   #    the existing tables first or the import fails on conflicts.
#   npx wrangler d1 execute lockerroom --remote --file=/path/to/backup.sql
#
# What a restore does NOT bring back: the Worker secrets. MAC_SALT especially.
# Device rows are keyed on SHA-256(mac + MAC_SALT), so restoring this dump
# against a DIFFERENT salt gives you rows nobody's phone will ever match again
# - every claim and every DJ attribution silently orphaned. The salt lives
# only in backend/.secrets.local. Back it up separately.
# ---------------------------------------------------------------------------
