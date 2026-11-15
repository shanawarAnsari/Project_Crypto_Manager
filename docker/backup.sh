#!/bin/sh
# Scheduled pg_dump with retention. `backup.sh once` takes a single backup and exits.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

: "${PGHOST:?PGHOST is required}"
PGUSER="${PGUSER:-${POSTGRES_USER:-}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-}}"
export PGUSER PGPASSWORD PGDATABASE
: "${PGUSER:?PGUSER (or POSTGRES_USER) is required}"
: "${PGPASSWORD:?PGPASSWORD (or POSTGRES_PASSWORD) is required}"
: "${PGDATABASE:?PGDATABASE (or POSTGRES_DB) is required}"

backup_once() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="${BACKUP_DIR}/.${PGDATABASE}_${ts}.dump.partial"
  out="${BACKUP_DIR}/${PGDATABASE}_${ts}.dump"
  if pg_dump --format=custom --no-owner --file="${tmp}"; then
    mv "${tmp}" "${out}"
    echo "backup ok: ${out}"
  else
    rm -f "${tmp}"
    echo "backup FAILED" >&2
    return 1
  fi
  find "${BACKUP_DIR}" -maxdepth 1 -name "${PGDATABASE}_*.dump" -type f -mtime "+${RETENTION_DAYS}" -print -delete
}

mkdir -p "${BACKUP_DIR}"

if [ "${1:-}" = "once" ]; then
  backup_once
  exit $?
fi

echo "backup loop: every ${INTERVAL}s, retention ${RETENTION_DAYS}d -> ${BACKUP_DIR}"
while true; do
  backup_once || true
  sleep "${INTERVAL}"
done
