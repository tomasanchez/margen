"""create debts table for the other-debts liability (ADR-187)

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-07-03 12:00:00.000000

Creates the ``debts`` table — a first-class :class:`Debt` aggregate for manual,
balance-bearing liabilities (personal loans, informal debts) not derived from
transactions (ADR-187). It mirrors ``DebtRecord``: a UUID pk with a
``gen_random_uuid()`` server default (ADR-026), a NOT NULL owner ``user_id`` column
with NO cross-schema FK to Supabase ``auth.users`` (ADR-094, ADR-130), a NOT NULL
``name`` and ``currency`` (ADR-183), a NOT NULL ``current_balance`` NUMERIC (the
non-negative outstanding amount, ADR-187), and the two NULLABLE extension-point
columns ``monthly_minimum`` and ``rate`` (ADR-187). The ``user_id`` column is indexed
for the owner-scoped list + net-worth ``liabilities.other`` derivation (ADR-108/130).

A debt is a standalone manual record with NO FK to any account, institution or
transaction (ADR-187): its balance feeds ``liabilities.other`` only and is disjoint
from the instalment tail (ADR-181) and the CC balance (ADR-185), so no double-count
arises (ADR-186). No data migration is involved — brand-new table.

The ``downgrade`` reverses the change: it drops the owner index and the ``debts`` table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: str | Sequence[str] | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``debts`` table and its owner index (ADR-187)."""
    op.create_table(
        "debts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("current_balance", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("monthly_minimum", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("rate", sa.Numeric(precision=9, scale=4), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_debts_user_id", "debts", ["user_id"])


def downgrade() -> None:
    """Drop the ``debts`` table and its owner index (ADR-187)."""
    op.drop_index("ix_debts_user_id", table_name="debts")
    op.drop_table("debts")
