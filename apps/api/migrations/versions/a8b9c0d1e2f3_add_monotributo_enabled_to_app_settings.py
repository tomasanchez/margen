"""add monotributo_enabled to app_settings, back-fill existing rows to true

Revision ID: a8b9c0d1e2f3
Revises: f7a8b9c0d1e2
Create Date: 2026-06-27 13:00:00.000000

Makes Monotributo an optional module gated by a per-user Settings flag (ADR-126,
amending ADR-053/054):

1. Adds the ``app_settings.monotributo_enabled`` boolean column with a server
   default of ``FALSE`` so brand-new rows (new users) start with the module OFF.
2. **In-place backfill**: every existing ``app_settings`` row is set to ``TRUE``
   so current users keep their Monotributo access without notice (ADR-126). The
   column is then NOT NULL.

Only the UI is gated by this flag. The M2M capture endpoint (ADR-064) is
unaffected -- it is a backend-only channel and stays active regardless of the
toggle.

The backfill runs through the bind connection with a single portable UPDATE so
the same path runs on PostgreSQL / Supabase (the production target) and the
in-memory SQLite the e2e tier uses. The column is added without a NOT NULL
constraint first, back-filled, then tightened to NOT NULL -- the server default
covers brand-new inserts and the backfill covers the pre-existing rows, so no row
is ever NULL.

This migration **rewrites existing prod rows** (it flips every existing settings
row to ``monotributo_enabled = TRUE``), so it MUST be applied to Supabase via the
CI migrate job (ADR-118) -- ``cd apps/api && uv run --env-file .env alembic
upgrade head`` -- only **after** a Supabase backup is taken.

The ``downgrade`` drops the ``monotributo_enabled`` column.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a8b9c0d1e2f3"
down_revision: str | Sequence[str] | None = "f7a8b9c0d1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``app_settings.monotributo_enabled`` and back-fill existing rows to TRUE (ADR-126)."""
    # Brand-new rows default to FALSE (the module is OFF for new users, ADR-126).
    # Added nullable first so the backfill can fill pre-existing rows before the
    # NOT NULL is enforced.
    op.add_column(
        "app_settings",
        sa.Column(
            "monotributo_enabled",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=True,
        ),
    )
    # Existing users keep Monotributo: flip every pre-existing row to TRUE (ADR-126).
    op.execute(sa.text("UPDATE app_settings SET monotributo_enabled = TRUE"))
    # Now that no row is NULL, tighten the column (the server default covers new rows).
    with op.batch_alter_table("app_settings") as batch:
        batch.alter_column("monotributo_enabled", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    """Drop ``app_settings.monotributo_enabled`` (the per-user toggle is discarded)."""
    op.drop_column("app_settings", "monotributo_enabled")
