"""SQLAlchemy persistence model for the ``Budget`` aggregate (ADR-125, ADR-130).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.budget``. SQLAlchemy stays in the adapters (AGENTS.md);
the domain object remains plain Python. Column conventions mirror
``MonotributoSnapshotRecord`` / ``AccountRecord``: UUID pk via ``gen_random_uuid``
(ADR-026), NUMERIC money (ADR-025), server-managed timestamps, and a NOT NULL
``user_id`` ownership column with no cross-schema FK to Supabase ``auth.users``
(ADR-094, ADR-130). A ``UNIQUE(user_id, category, period)`` constraint enforces one
target per category per month so the upsert never duplicates (ADR-125).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import Date, DateTime, Index, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class BudgetRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.budget.Budget`.

    ``amount`` is the per-category monthly target stored as ``NUMERIC(18, 2)`` in
    ``currency`` (ARS for the MVP, ADR-125 currency note). ``period`` is the first
    day of the budget month (the month-navigator period, ADR-040). ``category`` is a
    plain validated string (a ``KNOWN_CATEGORIES`` value, tolerant of unknowns per
    ADR-027). The actual spend is derived by the query side from the category
    summaries and is intentionally NOT a column (ADR-042, ADR-125).
    """

    __tablename__ = "budgets"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every budget is owned, so it is NOT NULL. No
    # ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table (ADR-094). The composite UNIQUE
    # below leads with ``user_id`` so it doubles as the owner-scoped read index.
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    period: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        # One target per owner per category per month; the upsert resolves on this
        # composite key so a category never has duplicate targets for a month
        # (ADR-125). Leading with ``user_id`` also serves the owner-scoped reads.
        UniqueConstraint("user_id", "category", "period", name="uq_budgets_user_category_period"),
        Index("ix_budgets_user_id", "user_id"),
    )
