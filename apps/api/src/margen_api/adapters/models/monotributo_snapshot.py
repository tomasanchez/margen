"""SQLAlchemy persistence model for the Monotributo snapshot history.

One row per evaluated trailing-12-month period (ADR-052), keyed by
``period_end`` month (unique), so the prior-period comparison reads frozen
historical figures instead of recomputing them against today's scale. The
``limit`` concept is stored as ``limit_amount`` because ``limit`` is a SQL
reserved word. Money columns are ``NUMERIC`` (ADR-025); timestamps are
server-managed like ``TransactionRecord``.
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import Date, DateTime, Index, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class MonotributoSnapshotRecord(Base):
    """Relational mapping of a persisted trailing-12-month standing (ADR-052).

    Each row freezes a computed standing for the window ending ``period_end``.
    ``limit_amount`` is the annual ceiling at capture time; ``used``, ``remaining``
    and ``percent_used`` are the derived figures. ``status`` is a band key
    (``safe`` / ``watch`` / ``close`` / ``over``) and ``projected_category`` the
    projected category, both as plain strings.
    """

    __tablename__ = "monotributo_snapshot"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-094, ADR-112): the snapshot is user-scoped — the
    # standing is per-user, computed from the owner's transactions. No ForeignKey
    # -- auth users live in Supabase's ``auth.users`` schema and the hermetic
    # SQLite e2e tier has no such table, so a cross-schema FK would break both
    # migrations and tests. Now NOT NULL (ADR-109; enforced in PROD only after the
    # backfill script fills legacy NULLs); the uniqueness/index below scope the
    # snapshot history to the owner.
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    period_start: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    period_end: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    category: Mapped[str] = mapped_column(String(2), nullable=False)
    activity_type: Mapped[str] = mapped_column(String(20), nullable=False)
    limit_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    used: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    remaining: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    percent_used: Mapped[Decimal] = mapped_column(Numeric(7, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    projected_category: Mapped[str] = mapped_column(String(2), nullable=False)
    captured_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        # One snapshot per owner per trailing-12-month period; reads upsert on this
        # composite key so each user's history is independent (ADR-052, ADR-112).
        UniqueConstraint("user_id", "period_end", name="uq_monotributo_snapshot_user_period_end"),
        # Index the ownership column for the user-scoped reads (ADR-112).
        Index("ix_monotributo_snapshot_user_id", "user_id"),
    )
