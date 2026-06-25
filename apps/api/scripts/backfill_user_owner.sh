#!/usr/bin/env bash
#
# backfill_user_owner.sh — one-off ADR-109 backfill. Assigns every existing
# owner-less row (user_id IS NULL) to a single owner's Supabase user id across
# the owned tables, so the column can later be tightened to NOT NULL.
#
# Run order (ADR-109):
#   1. THIS script — assign all existing NULL rows to the owner.   <-- you are here
#   2. Deploy app-layer enforcement (ADR-108: inserts set user_id; reads filter).
#   3. Alembic migration to set user_id NOT NULL (only after no NULLs remain).
#
# Idempotent: it only ever touches rows where user_id IS NULL, so re-running is
# a no-op (every row already owned -> "UPDATE 0").
#
# What it does:
#   - Resolves the Supabase DATABASE_URL from .env (never printed).
#   - Inside a SINGLE transaction, runs
#       UPDATE <table> SET user_id = :owner WHERE user_id IS NULL;
#     for each owned table, printing the affected row count per table.
#   - Prints a final per-table summary.
#
# Requirements: local `db` compose service up & healthy (its psql is the libpq
# client we shell through); uv; apps/api/.env with DATABASE_URL pointed at
# Supabase (postgresql+asyncpg://...). The Supabase secret is read from .env and
# never echoed. This is a manual, run-once operation — it is NOT wired into CI.
#
# Usage:
#   bash scripts/backfill_user_owner.sh <owner-supabase-user-id>
#
# Example:
#   bash scripts/backfill_user_owner.sh 6f3a1c2e-1234-4abc-9def-0123456789ab
#
set -euo pipefail

cd "$(dirname "$0")/.."          # -> apps/api (so docker compose finds the compose file)
ENV_FILE="${ENV_FILE:-.env}"

# Owned tables to backfill. NOTE on uniqueness constraints (ADR-109):
#   - app_settings has UNIQUE(user_id) (migration c3d4e5f6a7b8). The backfill
#     ASSUMES the legacy single owner-less row is the only app_settings row that
#     exists pre-backfill, so setting it to the owner cannot collide. If the
#     owner already had an app_settings row AND a separate NULL row exists, the
#     UPDATE would violate the unique constraint; the surrounding transaction
#     then rolls back the whole backfill cleanly — resolve the duplicate by hand
#     and re-run. (Pre-backfill this is not the case, so it is fine.)
#   - monotributo_snapshot has UNIQUE(user_id, period_end) — period_end keeps
#     the assigned rows distinct, so no collision.
TABLES=(transactions app_settings invoice_document statement_document monotributo_snapshot)

# --- Argument: the owner's Supabase user id (a UUID, e.g. an auth.users id). ---
OWNER_ID="${1:-}"
if [[ -z "$OWNER_ID" ]]; then
  echo "ERROR: missing owner Supabase user id." >&2
  echo "Usage: bash scripts/backfill_user_owner.sh <owner-supabase-user-id>" >&2
  exit 1
fi

# Validate the shape up front (canonical 8-4-4-4-12 hex UUID). This both catches
# typos and means the value can be safely passed as an SQL literal — no
# attacker-controlled, free-form string ever reaches the query.
if ! [[ "$OWNER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "ERROR: owner id '$OWNER_ID' is not a valid UUID." >&2
  echo "Usage: bash scripts/backfill_user_owner.sh <owner-supabase-user-id>" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (expected DATABASE_URL = Supabase)." >&2
  exit 1
fi

# Resolve the Supabase URL for libpq tools (psql can't use the +asyncpg driver
# suffix). Read via uv's dotenv parser; the value is captured, never echoed.
PSQL_URL="$(uv run --env-file "$ENV_FILE" python -c 'import os;print(os.environ["DATABASE_URL"].replace("+asyncpg",""))')"

# Build the transactional backfill. The validated UUID is bound through psql's
# -v variable and inlined as a quoted literal (:'owner'); ON_ERROR_STOP + the
# single transaction means any failure (e.g. a unique violation) rolls back the
# whole backfill — it is all-or-nothing.
SQL="BEGIN;"
for t in "${TABLES[@]}"; do
  SQL+=" \\echo '== ${t} =='"$'\n'
  SQL+="UPDATE ${t} SET user_id = :'owner' WHERE user_id IS NULL;"$'\n'
done
SQL+="COMMIT;"

echo "==> Backfilling owner-less rows to the provided owner across ${#TABLES[@]} tables..."
echo "    (each 'UPDATE n' below is the number of NULL rows assigned in that table)"
docker compose exec -T db \
  psql "$PSQL_URL" -v ON_ERROR_STOP=1 -v owner="$OWNER_ID" -c "$SQL"

echo "==> Verifying no owner-less rows remain..."
ok=1
for t in "${TABLES[@]}"; do
  remaining=$(docker compose exec -T db psql "$PSQL_URL" -tAc "select count(*) from $t where user_id is null" | tr -d '[:space:]')
  flag="OK"; [[ "$remaining" != "0" ]] && { flag="STILL NULL"; ok=0; }
  printf "    %-24s null_rows=%-6s %s\n" "$t" "$remaining" "$flag"
done
[[ "$ok" == "1" ]] && echo "Done — every row across the owned tables is now owned." || { echo "Some rows are still NULL — investigate before the NOT NULL migration." >&2; exit 1; }
