"""create accounts table and add transactions.account_id (no data migration)

Revision ID: f7a8b9c0d1e2
Revises: e5f6a7b8c9d0
Create Date: 2026-06-27 12:00:00.000000

Introduces the ``Account`` aggregate (ADR-122) and links transactions to it,
creating **only the empty structures** — no data migration (ADR-124, amended):

1. Creates the ``accounts`` table (UUID pk, owner ``user_id``, name, type,
   currency, opening_balance, timestamps) — mirroring ``AccountRecord``. The
   table starts **empty**: accounts are created manually by each owner, not
   auto-seeded from bank tags.
2. Adds the nullable ``transactions.account_id`` FK (``ondelete=SET NULL``) and
   indexes it for the owner-scoped balance aggregation. The column starts
   **NULL** for every existing row; the owner sets it as they assign each
   transaction to an account (enforced at the application layer per ADR-130).

``account_id`` is deliberately **nullable**: transactions begin unlinked and the
hermetic SQLite e2e tier creates rows with no account. A transaction may only
reference one of its owner's accounts (ADR-130).

This migration performs **no data rewrite** — it adds schema only — so it is
SQLite-compatible (the e2e tier) and portable to PostgreSQL / Supabase (the
production target). This reverses the original auto-seed decision (ADR-124): the
owner now creates accounts manually rather than having them migrated from bank
tags.

The ``downgrade`` drops ``transactions.account_id`` and the ``accounts`` table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: str | Sequence[str] | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the empty ``accounts`` table and add the nullable ``transactions.account_id``."""
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("opening_balance", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_accounts_user_id", "accounts", ["user_id"])

    op.add_column("transactions", sa.Column("account_id", sa.Uuid(), nullable=True))
    op.create_index("ix_transactions_account_id", "transactions", ["account_id"])
    op.create_foreign_key(
        "fk_transactions_account_id_accounts",
        "transactions",
        "accounts",
        ["account_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Drop ``transactions.account_id`` and the ``accounts`` table."""
    op.drop_constraint("fk_transactions_account_id_accounts", "transactions", type_="foreignkey")
    op.drop_index("ix_transactions_account_id", table_name="transactions")
    op.drop_column("transactions", "account_id")
    op.drop_index("ix_accounts_user_id", table_name="accounts")
    op.drop_table("accounts")
