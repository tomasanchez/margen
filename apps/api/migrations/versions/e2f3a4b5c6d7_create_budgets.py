"""create budgets table (per-category monthly targets, no backfill)

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-06-29 10:00:00.000000

Adds the ``budgets`` table backing the per-category monthly target ``Budget``
aggregate (ADR-125). A budget is a spending target the user sets for one expense
category in one calendar month (the month-navigator period, ADR-040); the actual
spend it is compared against is derived from the existing category summaries reader
(ADR-042), so the table stores only the target — never the spend.

The table mirrors ``AccountRecord`` / ``MonotributoSnapshotRecord`` conventions:
UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC(18,2) money (ADR-025),
server-managed timestamps, and a NOT NULL ``user_id`` ownership column with no
cross-schema FK to Supabase ``auth.users`` (ADR-094, ADR-130). A
``UNIQUE(user_id, category, period)`` constraint enforces one target per category
per month so the upsert never duplicates (ADR-125). There is **no data migration /
backfill** — budgets are a new concept.

The ``downgrade`` drops the table (and its unique constraint / index with it).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e2f3a4b5c6d7"
down_revision: str | Sequence[str] | None = "d1e2f3a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``budgets`` table with owner, category, period, amount and timestamps."""
    op.create_table(
        "budgets",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("category", sa.String(length=50), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "category", "period", name="uq_budgets_user_category_period"),
    )
    op.create_index("ix_budgets_user_id", "budgets", ["user_id"])


def downgrade() -> None:
    """Drop the ``budgets`` table and its index / unique constraint."""
    op.drop_index("ix_budgets_user_id", table_name="budgets")
    op.drop_table("budgets")
