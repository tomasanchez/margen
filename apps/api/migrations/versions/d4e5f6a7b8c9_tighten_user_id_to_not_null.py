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

Before tightening ``app_settings`` this migration deletes any owner-less
``user_id IS NULL`` row. That row is the obsolete global default seeded by
``cde5505de5cd``; under the per-user model (ADR-110) it has no owner and the
get-or-create path recreates per-user rows lazily. In PROD the ADR-109 backfill has
already claimed it (so it is non-null and survives); on a fresh DB / CI it is an
orphan whose removal lets the constraint apply. The cleanup is intentionally scoped to
``app_settings`` only -- a NULL ``user_id`` on the other owned tables means the
backfill was skipped and the tightening SHOULD fail loudly.

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
    # Remove the obsolete owner-less global-default ``app_settings`` row(s) before
    # tightening. ``cde5505de5cd`` seeded one global settings row that predates the
    # ``user_id`` column (added nullable in ``a1b2c3d4e5f6``), so it carries
    # ``user_id IS NULL``. Under the per-user model (ADR-110, get-or-create per user)
    # there is no global default: each user lazily creates their own row. In PROD the
    # ADR-109 backfill has already assigned that seeded row to the owner, so its
    # ``user_id`` is non-null and it survives this DELETE. On a fresh DB / CI the
    # seeded row is an unowned orphan the per-user code recreates lazily, so dropping
    # it is correct and lets the NOT NULL tightening below succeed.
    #
    # Scoped to ``app_settings`` ONLY. The other owned tables (transactions,
    # invoice_document, statement_document, monotributo_snapshot) must NOT be cleaned
    # this way: a NULL ``user_id`` there means the ADR-109 backfill was skipped, and
    # the SET NOT NULL below SHOULD fail loudly to force a backfill-first rollout.
    op.execute("DELETE FROM app_settings WHERE user_id IS NULL")

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
