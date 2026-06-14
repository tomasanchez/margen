"""create monotributo config and snapshot

Revision ID: 6d0d805e893c
Revises: 2de10033cc1c
Create Date: 2026-06-14 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6d0d805e893c"
down_revision: str | Sequence[str] | None = "2de10033cc1c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply the migration (ADR-048, ADR-052)."""
    op.create_table(
        "monotributo_config",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("current_category", sa.String(length=2), nullable=False),
        sa.Column("activity_type", sa.String(length=20), server_default="services", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "monotributo_snapshot",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("category", sa.String(length=2), nullable=False),
        sa.Column("activity_type", sa.String(length=20), nullable=False),
        sa.Column("limit_amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("used", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("remaining", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("percent_used", sa.Numeric(precision=7, scale=2), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("projected_category", sa.String(length=2), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period_end", name="uq_monotributo_snapshot_period_end"),
    )

    # Seed the single-row config with the default category C / services (ADR-048).
    op.bulk_insert(
        sa.table(
            "monotributo_config",
            sa.column("current_category", sa.String),
            sa.column("activity_type", sa.String),
        ),
        [{"current_category": "C", "activity_type": "services"}],
    )


def downgrade() -> None:
    """Revert the migration."""
    op.drop_table("monotributo_snapshot")
    op.drop_table("monotributo_config")
