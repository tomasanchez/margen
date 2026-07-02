"""add transactions forecast schedule fields (recurring cadence + installments)

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-07-02 10:00:00.000000

Three additive, non-destructive column adds for the schedule/commitment-driven
cash-flow forecast (ADR-174, ADR-176):

* ``transactions.recurring_cadence`` (``VARCHAR(20)``, nullable) — a short token
  describing how a committed outflow repeats: ``monthly`` / ``quarterly`` /
  ``annual`` for a subscription-style stream, or ``installment`` for one payment of
  a fixed-length instalment plan. Validated leniently in the domain (an unknown
  value normalizes to NULL); NULL for a one-off or un-classified movement.
* ``transactions.installments_total`` (``INTEGER``, nullable) — for an
  ``installment`` cadence, the plan's total number of payments (the ``M`` of a cuota
  ``N/M``); NULL otherwise.
* ``transactions.installments_index`` (``INTEGER``, nullable) — for an
  ``installment`` cadence, this payment's 1-based position (the ``N`` of a cuota
  ``N/M``); NULL otherwise. The domain enforces ``1 <= index <= total`` when both are
  present (ADR-174); the database keeps the columns free-form nullable.

Every column is additive (nullable, no NOT NULL, NO data backfill — existing rows
keep NULL and are simply excluded from the schedule-driven projection until a user
classifies them), so CI auto-migrate (ADR-118) is clean and no existing row is
touched. The ``downgrade`` drops the three columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5e6f7a8b9c0"
down_revision: str | Sequence[str] | None = "c4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the three nullable forecast schedule columns (no backfill)."""
    op.add_column("transactions", sa.Column("recurring_cadence", sa.String(length=20), nullable=True))
    op.add_column("transactions", sa.Column("installments_total", sa.Integer(), nullable=True))
    op.add_column("transactions", sa.Column("installments_index", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Drop the three forecast schedule columns."""
    op.drop_column("transactions", "installments_index")
    op.drop_column("transactions", "installments_total")
    op.drop_column("transactions", "recurring_cadence")
