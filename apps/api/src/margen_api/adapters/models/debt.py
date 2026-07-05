"""SQLAlchemy persistence model for the ``Debt`` aggregate (ADR-187, ADR-130, ADR-183).

The adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.debt``. SQLAlchemy stays in the adapters (AGENTS.md); the
domain object remains plain Python. Column conventions mirror ``AccountRecord``: UUID pk
via ``gen_random_uuid`` (ADR-026), NUMERIC money (ADR-025), server-managed timestamps,
and a NOT NULL ``user_id`` ownership column with no cross-schema FK to Supabase
``auth.users`` (ADR-094, ADR-130). ``monthly_minimum`` and ``rate`` are NULLABLE
extension points (ADR-187). A debt is a standalone manual record — no FK to any account,
institution or transaction (ADR-187).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class DebtRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.debt.Debt`.

    ``current_balance`` is stored as ``NUMERIC(18, 2)`` in the debt's own ``currency``
    (ADR-183) and is a non-negative obligation (enforced in the domain, ADR-187).
    ``currency`` is a plain validated string (the value of the domain enum), consistent
    with how the account/transaction models store their validated strings (ADR-027).
    ``monthly_minimum`` and ``rate`` are NULLABLE — optional extension points that carry
    no behaviour today (ADR-187).
    """

    __tablename__ = "debts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every debt is owned, so it is NOT NULL. No ForeignKey --
    # auth users live in Supabase's ``auth.users`` schema and the hermetic SQLite e2e tier
    # has no such table (ADR-094). Indexed for the owner-scoped reads (ADR-108/130).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    current_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    # Optional YAGNI extension points (ADR-187): a future minimum-payment / interest slice
    # populates these without a schema change; nullable and behaviourless today.
    monthly_minimum: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    rate: Mapped[Decimal | None] = mapped_column(Numeric(9, 4), nullable=True)
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
