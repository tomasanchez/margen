"""add nullable user_id ownership column

Revision ID: a1b2c3d4e5f6
Revises: f6dd6f51e112
Create Date: 2026-06-23 00:00:00.000000

Adds a nullable ``user_id`` ownership column to the user-owned aggregate tables
(ADR-094): ``transactions``, ``app_settings``, ``invoice_document``,
``statement_document``, and ``monotributo_snapshot``. This is forward-compat
scaffolding only -- the column sits unused/nullable until the deferred migration
(ADR-090) backfills it under an authenticated user; ownership is not enforced at
query time yet (ADR-095).

The column is a plain UUID with **no ForeignKey**: auth users live in Supabase's
``auth.users`` schema (ADR-091) and the hermetic SQLite e2e tier has no such
table, so a cross-schema FK would break migrations and tests. ``sa.UUID()``
renders as native ``uuid`` on PostgreSQL and a portable CHAR-backed type on
SQLite, mirroring the existing UUID primary keys (ADR-026). Pure reference/config
tables are intentionally excluded -- they carry no ownership. The downgrade drops
each column in reverse order.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "f6dd6f51e112"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# User-owned aggregate tables that receive the nullable ownership column (ADR-094).
_OWNED_TABLES: tuple[str, ...] = (
    "transactions",
    "app_settings",
    "invoice_document",
    "statement_document",
    "monotributo_snapshot",
)


def upgrade() -> None:
    """Add the nullable ``user_id`` column to each user-owned table (ADR-094)."""
    for table in _OWNED_TABLES:
        # Nullable, no FK (auth.users lives in a separate Supabase schema; the
        # SQLite test tier has no such table). Backfilled later (ADR-090).
        op.add_column(table, sa.Column("user_id", sa.UUID(), nullable=True))


def downgrade() -> None:
    """Drop the ``user_id`` column from each user-owned table in reverse order."""
    for table in reversed(_OWNED_TABLES):
        op.drop_column(table, "user_id")
