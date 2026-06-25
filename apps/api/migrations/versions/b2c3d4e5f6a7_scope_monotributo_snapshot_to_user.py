"""scope monotributo_snapshot to user

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-25 00:00:00.000000

Scopes the ``monotributo_snapshot`` history to the owner (ADR-112): the standing
is per-user, computed from the owner's transactions, while the AFIP scale stays
shared reference data. The ``user_id`` ownership column already exists (ADR-094,
revision ``a1b2c3d4e5f6``); this migration widens the uniqueness from
``(period_end)`` to ``(user_id, period_end)`` so each user's monthly snapshot is
independent, and adds a ``user_id`` index for the user-scoped reads.

The downgrade reverses both: it drops the composite unique constraint and the
index, then restores the single-column ``(period_end)`` unique constraint.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "monotributo_snapshot"
_OLD_UQ = "uq_monotributo_snapshot_period_end"
_NEW_UQ = "uq_monotributo_snapshot_user_period_end"
_IX = "ix_monotributo_snapshot_user_id"


def upgrade() -> None:
    """Widen the uniqueness to ``(user_id, period_end)`` and index ``user_id`` (ADR-112)."""
    op.drop_constraint(_OLD_UQ, _TABLE, type_="unique")
    op.create_unique_constraint(_NEW_UQ, _TABLE, ["user_id", "period_end"])
    op.create_index(_IX, _TABLE, ["user_id"])


def downgrade() -> None:
    """Restore the single-column ``(period_end)`` uniqueness (ADR-112)."""
    op.drop_index(_IX, table_name=_TABLE)
    op.drop_constraint(_NEW_UQ, _TABLE, type_="unique")
    op.create_unique_constraint(_OLD_UQ, _TABLE, ["period_end"])
