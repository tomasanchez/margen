"""add nullable card_brand + card_last4 to institutions

Revision ID: f8a9b0c1d2e3
Revises: e6f7a8b9c0d1
Create Date: 2026-07-06 12:00:00.000000

Persists a card's identity on its institution (ADR-190). An Argentine dual-currency
card is one ``institution`` with two child accounts (ARS + USD); the card's identity
(which physical card it is) spans both, so it lives on the institution, not the
account.

The upgrade adds two NULLABLE columns:

* ``card_brand`` — ``String(50)`` nullable (the network label, e.g. "VISA", "AMEX",
  "Mastercard"; free-text so new networks need no code change).
* ``card_last4`` — ``String(4)`` nullable (the four-digit printed suffix).

Both are nullable and there is **no backfill**: bank / cash / wallet institutions
(and any card created before registration existed) simply carry ``NULL`` and are
entirely unaffected (ADR-190). Adding nullable columns is SQLite-compatible (plain
``ADD COLUMN``), so the additive change also applies on the in-memory e2e tier.

The ``downgrade`` drops both columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f8a9b0c1d2e3"
down_revision: str | Sequence[str] | None = "e6f7a8b9c0d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable ``card_brand`` / ``card_last4`` columns to ``institutions`` (ADR-190)."""
    op.add_column("institutions", sa.Column("card_brand", sa.String(length=50), nullable=True))
    op.add_column("institutions", sa.Column("card_last4", sa.String(length=4), nullable=True))


def downgrade() -> None:
    """Drop the card identity columns (ADR-190)."""
    op.drop_column("institutions", "card_last4")
    op.drop_column("institutions", "card_brand")
