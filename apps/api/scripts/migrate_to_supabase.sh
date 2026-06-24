#!/usr/bin/env bash
#
# migrate_to_supabase.sh — one-time cutover of the local dev Postgres into the
# Supabase-managed Postgres (ADR-091). Copies existing rows AS-IS; the new
# nullable `user_id` column stays NULL (re-homing under a user is the deferred
# follow-up, ADR-094).
#
# What it does:
#   1. Applies the Alembic schema to Supabase   (uv run --env-file .env)
#   2. Dumps the local data-only SQL from the pg17 container (no schema, no
#      alembic_version row)
#   3. Loads it into Supabase via the container's psql
#   4. Verifies row counts match on both sides
#
# Requirements: local `db` compose service up & healthy; uv; apps/api/.env with
# DATABASE_URL pointed at Supabase (postgresql+asyncpg://...). The Supabase
# secret is read from .env and never printed.
#
# Usage:
#   bash scripts/migrate_to_supabase.sh            # first run
#   RESET=1 bash scripts/migrate_to_supabase.sh    # TRUNCATE Supabase tables first (re-run)
#
set -euo pipefail

cd "$(dirname "$0")/.."          # -> apps/api
ENV_FILE="${ENV_FILE:-.env}"
TABLES=(transactions app_settings invoice_document statement_document monotributo_snapshot)
DUMP="$(mktemp -t margen_data.XXXXXX.sql)"
trap 'rm -f "$DUMP"' EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (expected DATABASE_URL = Supabase)." >&2
  exit 1
fi

# Resolve the Supabase URL for libpq tools (psql can't use the +asyncpg driver
# suffix). Read via uv's dotenv parser; the value is captured, never echoed.
PSQL_URL="$(uv run --env-file "$ENV_FILE" python -c 'import os;print(os.environ["DATABASE_URL"].replace("+asyncpg",""))')"

echo "==> [1/4] Applying Alembic schema to Supabase (alembic upgrade head)..."
uv run --env-file "$ENV_FILE" alembic upgrade head

if [[ "${RESET:-0}" == "1" ]]; then
  echo "==> [reset] TRUNCATING Supabase tables (RESET=1)..."
  docker compose exec -T db \
    psql "$PSQL_URL" -v ON_ERROR_STOP=1 \
    -c "TRUNCATE $(IFS=,; echo "${TABLES[*]}") RESTART IDENTITY CASCADE;"
fi

echo "==> [2/4] Dumping local data (data-only, excluding alembic_version)..."
docker compose exec -T db pg_dump \
  --data-only --no-owner --no-privileges \
  --exclude-table=alembic_version \
  -U margen-api margen-api > "$DUMP"
echo "    dump size: $(wc -c < "$DUMP" | tr -d ' ') bytes"

echo "==> [3/4] Loading data into Supabase (via container psql, ON_ERROR_STOP)..."
docker compose exec -T db \
  psql "$PSQL_URL" -v ON_ERROR_STOP=1 -f - < "$DUMP"

echo "==> [4/4] Verifying row counts (local vs Supabase)..."
ok=1
for t in "${TABLES[@]}"; do
  local_n=$(docker compose exec -T db psql -U margen-api -d margen-api -tAc "select count(*) from $t" | tr -d '[:space:]')
  remote_n=$(docker compose exec -T db psql "$PSQL_URL" -tAc "select count(*) from $t" | tr -d '[:space:]')
  flag="OK"; [[ "$local_n" != "$remote_n" ]] && { flag="MISMATCH"; ok=0; }
  printf "    %-24s local=%-6s supabase=%-6s %s\n" "$t" "$local_n" "$remote_n" "$flag"
done
[[ "$ok" == "1" ]] && echo "Done — counts match." || { echo "Counts DIFFER — investigate before retiring the local DB." >&2; exit 1; }
