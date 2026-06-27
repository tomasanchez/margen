"""institution -> account hierarchy and wallet type (no data migration)

Revision ID: c0d1e2f3a4b5
Revises: a8b9c0d1e2f3
Create Date: 2026-06-27 13:00:00.000000

Splits the flat ``Account`` into an ``Institution`` -> ``Account`` hierarchy
(ADR-134). The accounts table is **empty on every database** (ADR-124), so this is
a pure schema restructure with **no data migration**:

1. Creates the ``institutions`` table (UUID pk, owner ``user_id``, name, type,
   timestamps) — mirroring ``InstitutionRecord``. ``type`` now includes
   ``wallet`` (Deel / Payoneer / Mercado Pago); the type is a plain validated
   string column, so no check constraint changes are needed.
2. Adds the NOT NULL ``accounts.institution_id`` FK (``ondelete=CASCADE``) and
   indexes it. Safe as NOT NULL because the table is empty.
3. Drops ``accounts.name`` and ``accounts.type`` — they live on the institution
   now (ADR-134).

``transactions.account_id`` is unchanged: it still references a currency-specific
``Account`` (ADR-133).

The ``downgrade`` reverses the change: it re-adds ``accounts.type`` and
``accounts.name`` (nullable, since the table is empty), drops
``accounts.institution_id`` and its FK/index, and drops the ``institutions``
table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c0d1e2f3a4b5"
down_revision: str | Sequence[str] | None = "a8b9c0d1e2f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create ``institutions``; move name/type off ``accounts`` onto the institution."""
    op.create_table(
        "institutions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_institutions_user_id", "institutions", ["user_id"])

    # The accounts table is empty (ADR-124), so a NOT NULL FK is safe to add directly.
    op.add_column("accounts", sa.Column("institution_id", sa.Uuid(), nullable=False))
    op.create_index("ix_accounts_institution_id", "accounts", ["institution_id"])
    op.create_foreign_key(
        "fk_accounts_institution_id_institutions",
        "accounts",
        "institutions",
        ["institution_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # name/type move to the institution (ADR-134).
    op.drop_column("accounts", "name")
    op.drop_column("accounts", "type")


def downgrade() -> None:
    """Re-add ``accounts.name``/``type``; drop ``institution_id`` and ``institutions``."""
    # Re-add as nullable: the table is empty, so no back-fill value is needed.
    op.add_column("accounts", sa.Column("type", sa.String(length=20), nullable=True))
    op.add_column("accounts", sa.Column("name", sa.String(length=200), nullable=True))

    op.drop_constraint("fk_accounts_institution_id_institutions", "accounts", type_="foreignkey")
    op.drop_index("ix_accounts_institution_id", table_name="accounts")
    op.drop_column("accounts", "institution_id")

    op.drop_index("ix_institutions_user_id", table_name="institutions")
    op.drop_table("institutions")
