"""add budgets.kind + swap UNIQUE to (user_id, kind, category, period)

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-06-30 11:05:00.000000

Adds the ``kind`` discriminator to the ``budgets`` table so saving-bucket
allocations live in the same table as spend targets (ADR-138). ``kind`` is NOT NULL
with a ``'spend'`` server default, so existing rows back-fill to ``spend`` and the
change is fully back-compatible (every current row is implicitly a spend target).

The load-bearing part is **widening the UNIQUE** from ADR-125's
``(user_id, category, period)`` to ``(user_id, kind, category, period)`` so a spend
and a saving row can share a ``category``/month without colliding, the vs-actuals
join stays clean, and the Phase-2 saving extract is a simple ``WHERE kind='saving'``
(ADR-138). The constraint swap runs inside ``batch_alter_table`` so it is portable:
SQLite (the hermetic e2e tier, ADR-019) has no ``ALTER ... DROP CONSTRAINT``, so
Alembic's batch mode recreates the table; PostgreSQL (the production target) performs
the drop/add in place.

The change is additive with a server default, so CI auto-migrate (ADR-118) is clean.
The ``downgrade`` reverses it: restore the original UNIQUE then drop ``kind`` (a
``saving`` row would violate the narrower constraint, but downgrades run only on a
spend-only history).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_UNIQUE = "uq_budgets_user_category_period"
_NEW_UNIQUE = "uq_budgets_user_kind_category_period"


def upgrade() -> None:
    """Add ``kind`` (default 'spend') and swap the UNIQUE to include it (batch, SQLite-safe)."""
    op.add_column(
        "budgets",
        sa.Column("kind", sa.String(length=10), server_default="spend", nullable=False),
    )
    with op.batch_alter_table("budgets", schema=None) as batch_op:
        batch_op.drop_constraint(_OLD_UNIQUE, type_="unique")
        batch_op.create_unique_constraint(_NEW_UNIQUE, ["user_id", "kind", "category", "period"])


def downgrade() -> None:
    """Restore the original ``(user_id, category, period)`` UNIQUE and drop ``kind``."""
    with op.batch_alter_table("budgets", schema=None) as batch_op:
        batch_op.drop_constraint(_NEW_UNIQUE, type_="unique")
        batch_op.create_unique_constraint(_OLD_UNIQUE, ["user_id", "category", "period"])
    op.drop_column("budgets", "kind")
