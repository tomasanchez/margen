"""add nullable pardoned_at to receivable_item (ADR-210)

Revision ID: b0c1d2e3f4a5
Revises: a9b0c1d2e3f4
Create Date: 2026-08-29 12:00:00.000000

Adds the nullable ``receivable_item.pardoned_at`` timestamptz backing the reversible
"pardon (forgive) a receivable item" feature (ADR-210). A non-NULL value marks the item as
forgiven ("covered by you"): it drops out of the person's outstanding roll-up and is no
longer a valid payment-allocation target (amending ADR-206), yet is retained so the
shareable statement can show it as covered (amending ADR-209). NULL means the item is a
normal, still-owed debt; un-pardoning simply resets the column to NULL.

The column is additive and nullable with no server default and no data backfill — every
existing item starts life un-pardoned (``pardoned_at IS NULL``), exactly the going-forward
rollout the debts/offset-link migrations use. It carries no ``account_id`` and adds no FK,
so receivables stay structurally excluded from net worth (ADR-205). The ``downgrade`` drops
the column.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b0c1d2e3f4a5"
down_revision: str | Sequence[str] | None = "a9b0c1d2e3f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable ``receivable_item.pardoned_at`` timestamptz (ADR-210)."""
    op.add_column(
        "receivable_item",
        sa.Column("pardoned_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Drop the ``receivable_item.pardoned_at`` column (ADR-210)."""
    op.drop_column("receivable_item", "pardoned_at")
