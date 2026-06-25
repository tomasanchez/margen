#!/usr/bin/env bash
#
# sync_from_supabase.sh — pull data FROM the Supabase DB INTO the local dev
# Postgres. Reverse of migrate_to_supabase.sh. Data-only.
#
# WARNING: this OVERWRITES the local target tables (TRUNCATE then load) so local
# mirrors Supabase. Intended for refreshing local dev/test data from the
# Supabase source of truth. The Supabase secret is read from .env, never printed.
#
# Usage: bash scripts/sync_from_supabase.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."          # -> apps/api (so docker compose finds the compose file)
ENV_FILE="${ENV_FILE:-.env}"
TABLES=(transactions app_settings invoice_document statement_document monotributo_snapshot)
DUMP="$(mktemp -t margen_supabase_data.XXXXXX.sql)"
trap 'rm -f "$DUMP"' EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (expected DATABASE_URL = Supabase)." >&2
  exit 1
fi

# Resolve the Supabase URL for libpq tools (strip the +asyncpg driver suffix).
# Read via uv's dotenv parser; the value is captured, never echoed.
PSQL_URL="$(uv run --env-file "$ENV_FILE" python -c 'import os;print(os.environ["DATABASE_URL"].replace("+asyncpg",""))')"

echo "==> [1/4] Dumping data from Supabase (data-only, our public tables only)..."
# Restrict to our application tables — a bare dump would also pull Supabase's
# own schemas (auth, storage, …) which don't exist locally.
DUMP_TABLES=(); for t in "${TABLES[@]}"; do DUMP_TABLES+=(-t "public.$t"); done
docker compose exec -T db pg_dump "$PSQL_URL" \
  --data-only --no-owner --no-privileges \
  "${DUMP_TABLES[@]}" > "$DUMP"
echo "    dump size: $(wc -c < "$DUMP" | tr -d ' ') bytes"

echo "==> [2/4] TRUNCATING local target tables..."
docker compose exec -T db psql -U margen-api -d margen-api -v ON_ERROR_STOP=1 \
  -c "TRUNCATE $(IFS=,; echo "${TABLES[*]}") RESTART IDENTITY CASCADE;"

echo "==> [3/4] Loading Supabase data into local (ON_ERROR_STOP)..."
docker compose exec -T db psql -U margen-api -d margen-api -v ON_ERROR_STOP=1 -f - < "$DUMP"

echo "==> [4/4] Verifying row counts (Supabase vs local)..."
ok=1
for t in "${TABLES[@]}"; do
  remote_n=$(docker compose exec -T db psql "$PSQL_URL" -tAc "select count(*) from $t" | tr -d '[:space:]')
  local_n=$(docker compose exec -T db psql -U margen-api -d margen-api -tAc "select count(*) from $t" | tr -d '[:space:]')
  flag="OK"; [[ "$remote_n" != "$local_n" ]] && { flag="MISMATCH"; ok=0; }
  printf "    %-24s supabase=%-6s local=%-6s %s\n" "$t" "$remote_n" "$local_n" "$flag"
done
[[ "$ok" == "1" ]] && echo "Done — local now mirrors Supabase." || { echo "Counts DIFFER — investigate." >&2; exit 1; }
