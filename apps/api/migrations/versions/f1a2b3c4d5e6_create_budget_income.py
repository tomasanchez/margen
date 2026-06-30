"""create budget_income table (per-month net-income base + household floor)

Revision ID: f1a2b3c4d5e6
Revises: e2f3a4b5c6d7
Create Date: 2026-06-30 11:00:00.000000

Adds the ``budget_income`` table backing the per-month net-spendable-income base
``BudgetIncome`` aggregate (ADR-139). The base is the income every budget percentage
is applied to — NOT gross collections (product-deliverable §2.1) — keyed
``(user_id, period)`` so it aligns to the month navigator (ADR-040), the wrong
cardinality for an ``app_settings`` singleton. The row also co-locates the household
floor (essentials the plan must never underfund, budget-design §9.1.1) as
``floor_amount`` / ``floor_source`` so it is read together with income (ADR-143).

The table mirrors ``BudgetRecord`` / ``AppSettingsRecord`` conventions: UUID pk via
``gen_random_uuid`` (ADR-026), NUMERIC(18,2) money (ADR-025), server-managed
timestamps, and a NOT NULL ``user_id`` ownership column with no cross-schema FK to
Supabase ``auth.users`` (ADR-094, ADR-130). A ``UNIQUE(user_id, period)`` constraint
enforces one base per user per month so the upsert never duplicates (ADR-139). There
is **no data migration / backfill** — the income base is a new concept; the table is
additive with server defaults, so CI auto-migrate (ADR-118) is clean.

The ``downgrade`` drops the table (and its unique constraint / index with it).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "e2f3a4b5c6d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``budget_income`` table with owner, period, amount, floor and timestamps."""
    op.create_table(
        "budget_income",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="ARS", nullable=False),
        sa.Column("source", sa.String(length=20), server_default="manual", nullable=False),
        sa.Column("floor_amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("floor_source", sa.String(length=20), server_default="manual", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "period", name="uq_budget_income_user_period"),
    )
    op.create_index("ix_budget_income_user_id", "budget_income", ["user_id"])


def downgrade() -> None:
    """Drop the ``budget_income`` table and its index / unique constraint."""
    op.drop_index("ix_budget_income_user_id", table_name="budget_income")
    op.drop_table("budget_income")
