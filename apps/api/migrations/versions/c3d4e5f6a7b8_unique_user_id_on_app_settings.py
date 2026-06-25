"""unique user_id on app_settings

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-06-25 00:00:00.000000

Makes ``app_settings`` per-user (ADR-110): the settings row is now one-per-user,
lazily get-or-created on first write. The ``user_id`` ownership column already
exists (ADR-094, revision ``a1b2c3d4e5f6``); this migration adds a
``UNIQUE(user_id)`` constraint so a user cannot accumulate duplicate settings
rows, plus a ``user_id`` index for the owner-scoped reads. The legacy single row
is assigned to the backfill owner by a separate script (ADR-109), not here.

``UNIQUE`` on a nullable column allows multiple NULLs on both PostgreSQL and
SQLite, so the pre-backfill legacy row (``user_id IS NULL``) does not collide with
freshly created per-user rows. The downgrade drops the index and the constraint.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | Sequence[str] | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "app_settings"
_UQ = "uq_app_settings_user_id"
_IX = "ix_app_settings_user_id"


def upgrade() -> None:
    """Add ``UNIQUE(user_id)`` and a ``user_id`` index to ``app_settings`` (ADR-110)."""
    op.create_unique_constraint(_UQ, _TABLE, ["user_id"])
    op.create_index(_IX, _TABLE, ["user_id"])


def downgrade() -> None:
    """Drop the ``user_id`` index and the ``UNIQUE(user_id)`` constraint (ADR-110)."""
    op.drop_index(_IX, table_name=_TABLE)
    op.drop_constraint(_UQ, _TABLE, type_="unique")
