"""add transactions.fx_source + app_settings.preferred_rate_source

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-06-30 14:00:00.000000

Two additive, non-destructive column adds for the FX-snapshot money model
(ADR-148, ADR-151):

* ``transactions.fx_source`` (``VARCHAR(20)``, nullable) — the per-row FX snapshot
  rate provenance the client supplies on write (e.g. ``'bolsa'`` / ``'mep'`` /
  ``'oficial'`` / ``'manual'`` / ``'backfill'``, ADR-148). Distinct from the legacy
  ``fx_rate_type`` (ADR-029). Nullable so existing rows and statement imports pending
  the client rate-fill step (ADR-149) carry ``None``. NO data backfill here — the
  ``usd_amount`` backfill is client-driven (ADR-149/150).
* ``app_settings.preferred_rate_source`` (``VARCHAR(20)``, NOT NULL, server default
  ``'bolsa'``) — the persisted preferred FX rate source (ADR-151). The server default
  back-fills existing rows to ``'bolsa'`` so the NOT NULL add is safe.

The change is additive with a server default where NOT NULL, so CI auto-migrate
(ADR-118) is clean. The ``downgrade`` drops both columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3c4d5e6f7a8"
down_revision: str | Sequence[str] | None = "a2b3c4d5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable ``fx_source`` snapshot column and the ``preferred_rate_source`` setting."""
    op.add_column(
        "transactions",
        sa.Column("fx_source", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("preferred_rate_source", sa.String(length=20), server_default="bolsa", nullable=False),
    )


def downgrade() -> None:
    """Drop the ``preferred_rate_source`` setting and the ``fx_source`` snapshot column."""
    op.drop_column("app_settings", "preferred_rate_source")
    op.drop_column("transactions", "fx_source")
