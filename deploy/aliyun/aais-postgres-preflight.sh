#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# Non-secret root wrapper for the read-only empty-database preflight. Run this
# from the checked-out AAIS candidate on the target ECS after PostgreSQL roles,
# migrations, and target identity have been configured. It uses local peer
# authentication as the postgres OS account; no password is accepted here.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
database_name="${AAIS_POSTGRES_DATABASE:-aais}"
target_id="${AAIS_DATABASE_TARGET_ID:-}"
socket_dir="/run/aais/postgresql"

if [[ "${EUID}" -ne 0 ]]; then
  echo "AAIS PostgreSQL preflight must run as root." >&2
  exit 1
fi
if [[ ! "$database_name" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
  echo "AAIS PostgreSQL database name is invalid." >&2
  exit 1
fi
if [[ ! "$target_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
  echo "AAIS_DATABASE_TARGET_ID is required and invalid." >&2
  exit 1
fi
for command_name in psql runuser stat readlink; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "AAIS PostgreSQL preflight dependency is unavailable: ${command_name}." >&2
    exit 1
  fi
done
socket_identity_before="$(stat -c '%d:%i' "$socket_dir" 2>/dev/null || true)"
socket_identity_after="$(stat -c '%d:%i' "$socket_dir" 2>/dev/null || true)"
socket_canonical="$(readlink -f -- "$socket_dir" 2>/dev/null || true)"
socket_mode="$(stat -c '%a' "$socket_dir" 2>/dev/null || true)"
if [[ ! -d "$socket_dir" || -L "$socket_dir" \
  || -z "$socket_identity_before" \
  || "$socket_identity_after" != "$socket_identity_before" \
  || "$socket_canonical" != "$socket_dir" \
  || "$socket_mode" != "770" ]]; then
  echo "AAIS PostgreSQL socket directory is invalid." >&2
  exit 1
fi

if [[ ! -S "$socket_dir/.s.PGSQL.5432" || -L "$socket_dir/.s.PGSQL.5432" ]]; then
  echo "AAIS PostgreSQL Unix socket is unavailable." >&2
  exit 1
fi

exec runuser -u postgres -- env \
  PGHOST="$socket_dir" \
  PGPORT=5432 \
  PGUSER=postgres \
  PGDATABASE="$database_name" \
  psql --no-password \
    -v TARGET_ID="$target_id" \
    -f "$script_dir/postgres-empty-preflight.sql"
