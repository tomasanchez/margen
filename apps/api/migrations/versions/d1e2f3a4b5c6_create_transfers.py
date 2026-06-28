"""create transfers table (account-to-account transfers, no backfill)

Revision ID: d1e2f3a4b5c6
Revises: c0d1e2f3a4b5
Create Date: 2026-06-27 15:00:00.000000

Adds the ``transfers`` table backing the account-to-account ``Transfer`` aggregate
(ADR-135). A transfer is an internal money movement between two of the user's own
accounts — NOT income/expense and NOT a transaction. It moves ``amount_out`` out of
the source account and ``amount_in`` into the destination account, each in that
account's native currency (ADR-123); a same-currency transfer is net-zero. Fees are
recorded separately as expense transactions (no schema change here).

The table mirrors ``AccountRecord`` conventions: UUID pk via ``gen_random_uuid``
(ADR-026), NUMERIC(18,2) money (ADR-025), server-managed timestamps, and a NOT NULL
``user_id`` ownership column with no cross-schema FK to Supabase ``auth.users``
(ADR-094, ADR-130). Both account FKs use ``ondelete=CASCADE`` so removing an account
removes its transfers, consistent with how an institution cascades to its accounts
(ADR-134). There is **no data migration / backfill** — transfers are a new concept.

The ``downgrade`` drops the table (and its indexes/FKs with it).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: str | Sequence[str] | None = "c0d1e2f3a4b5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``transfers`` table with owner, account FKs, amounts and timestamps."""
    op.create_table(
        "transfers",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("from_account_id", sa.Uuid(), nullable=False),
        sa.Column("to_account_id", sa.Uuid(), nullable=False),
        sa.Column("amount_out", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("amount_in", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["from_account_id"],
            ["accounts.id"],
            name="fk_transfers_from_account_id_accounts",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["to_account_id"],
            ["accounts.id"],
            name="fk_transfers_to_account_id_accounts",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_transfers_user_id", "transfers", ["user_id"])
    op.create_index("ix_transfers_from_account_id", "transfers", ["from_account_id"])
    op.create_index("ix_transfers_to_account_id", "transfers", ["to_account_id"])


def downgrade() -> None:
    """Drop the ``transfers`` table and its indexes / foreign keys."""
    op.drop_index("ix_transfers_to_account_id", table_name="transfers")
    op.drop_index("ix_transfers_from_account_id", table_name="transfers")
    op.drop_index("ix_transfers_user_id", table_name="transfers")
    op.drop_table("transfers")
