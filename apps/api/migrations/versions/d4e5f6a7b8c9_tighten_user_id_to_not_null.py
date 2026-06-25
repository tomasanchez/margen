"""tighten user_id to NOT NULL

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-06-25 00:00:00.000000

Tightens the ``user_id`` ownership column to ``NOT NULL`` across all five
user-owned tables (ADR-109): ``transactions``, ``app_settings``,
``invoice_document``, ``statement_document``, and ``monotributo_snapshot``. The
column was introduced nullable for forward-compat (ADR-094); every write path now
sets it (ADR-108) so the constraint can be enforced.

NOT NULL is the FINAL step of the ADR-109 rollout and is safe to run in PROD only
**after** the one-off backfill script has assigned every existing NULL row to the
owner. Required PROD rollout order:

1. Run the backfill script (assigns legacy ``user_id IS NULL`` rows to the owner).
2. Deploy app-layer enforcement (inserts set ``user_id``; reads filter by it —
   ADR-108).
3. Run THIS migration to set ``NOT NULL`` once no NULLs remain.

In the hermetic SQLite e2e tier there are no legacy rows and every API-created row
sets ``user_id``, so the constraint holds in tests. Per ADR-094 the column stays a
plain UUID with no ForeignKey to ``auth.users`` (Supabase-only schema; would break
SQLite e2e).

This migration also indexes ``user_id`` on the three tables that lack one
(``transactions``, ``invoice_document``, ``statement_document``) for the
owner-scoped reads (ADR-107/108). ``app_settings`` (revision ``c3d4e5f6a7b8``) and
``monotributo_snapshot`` (revision ``b2c3d4e5f6a7``) already have their index.

The downgrade reverts both: it drops the three indexes and relaxes ``user_id``
back to nullable on all five tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# All five user-owned tables whose ``user_id`` is tightened to NOT NULL (ADR-109).
_OWNED_TABLES: tuple[str, ...] = (
    "transactions",
    "app_settings",
    "invoice_document",
    "statement_document",
    "monotributo_snapshot",
)

# Tables that still lack a ``user_id`` index; the other two were indexed earlier
# (``app_settings`` in ``c3d4e5f6a7b8``, ``monotributo_snapshot`` in
# ``b2c3d4e5f6a7``). Names match the SQLAlchemy ``index=True`` convention.
_TABLES_NEEDING_INDEX: tuple[str, ...] = (
    "transactions",
    "invoice_document",
    "statement_document",
)


def _index_name(table: str) -> str:
    """Return the SQLAlchemy default index name for ``table.user_id``."""
    return f"ix_{table}_user_id"


def upgrade() -> None:
    """Set ``user_id`` NOT NULL on all owned tables and index the three lacking one."""
    for table in _OWNED_TABLES:
        op.alter_column(
            table,
            "user_id",
            existing_type=sa.UUID(),
            nullable=False,
        )
    for table in _TABLES_NEEDING_INDEX:
        op.create_index(_index_name(table), table, ["user_id"])


def downgrade() -> None:
    """Relax ``user_id`` back to nullable and drop the three added indexes."""
    for table in reversed(_TABLES_NEEDING_INDEX):
        op.drop_index(_index_name(table), table_name=table)
    for table in reversed(_OWNED_TABLES):
        op.alter_column(
            table,
            "user_id",
            existing_type=sa.UUID(),
            nullable=True,
        )
