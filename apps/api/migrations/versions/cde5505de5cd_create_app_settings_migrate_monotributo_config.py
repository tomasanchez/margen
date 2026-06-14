"""create app_settings, migrate monotributo_config row, drop monotributo_config

Revision ID: cde5505de5cd
Revises: 6d0d805e893c
Create Date: 2026-06-14 00:00:00.000000

Consolidates settings into a single-row ``app_settings`` table (ADR-054) and
carries the existing ``monotributo_config`` row's category / activity type
forward before dropping the old table (ADR-055). The downgrade recreates
``monotributo_config`` and copies the Monotributo fields back, then drops
``app_settings`` -- no user data is lost on either path.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "cde5505de5cd"
down_revision: str | Sequence[str] | None = "6d0d805e893c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create app_settings, seed from monotributo_config, drop the old table."""
    op.create_table(
        "app_settings",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "preferred_display_currency",
            sa.String(length=3),
            server_default="ARS",
            nullable=False,
        ),
        sa.Column(
            "fx_default_rate_type",
            sa.String(length=20),
            server_default="MEP",
            nullable=False,
        ),
        sa.Column("monotributo_current_category", sa.String(length=2), nullable=False),
        sa.Column(
            "monotributo_activity_type",
            sa.String(length=20),
            server_default="services",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    # Carry the existing single-row config forward (ADR-055). The id and the
    # timestamps use their column defaults; preferred_display_currency and
    # fx_default_rate_type take their ADR-054 defaults via COALESCE so a single
    # statement covers both "row exists" and "no row" cases.
    op.execute(
        sa.text(
            """
            INSERT INTO app_settings (
                preferred_display_currency,
                fx_default_rate_type,
                monotributo_current_category,
                monotributo_activity_type
            )
            SELECT
                'ARS',
                'MEP',
                COALESCE(mc.current_category, 'C'),
                COALESCE(mc.activity_type, 'services')
            FROM (SELECT 1) AS one
            LEFT JOIN monotributo_config AS mc ON TRUE
            """
        )
    )

    op.drop_table("monotributo_config")


def downgrade() -> None:
    """Recreate monotributo_config, copy fields back, drop app_settings."""
    op.create_table(
        "monotributo_config",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("current_category", sa.String(length=2), nullable=False),
        sa.Column("activity_type", sa.String(length=20), server_default="services", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    # Restore the Monotributo fields from app_settings (ADR-055). Falls back to
    # the ADR-048 seed default if app_settings somehow holds no row.
    op.execute(
        sa.text(
            """
            INSERT INTO monotributo_config (current_category, activity_type)
            SELECT
                COALESCE(s.monotributo_current_category, 'C'),
                COALESCE(s.monotributo_activity_type, 'services')
            FROM (SELECT 1) AS one
            LEFT JOIN app_settings AS s ON TRUE
            """
        )
    )

    op.drop_table("app_settings")
