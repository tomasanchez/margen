"""SQLAlchemy persistence model for the ``Transaction`` aggregate.

This is the adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.transaction``. SQLAlchemy stays in the adapters
(AGENTS.md); the domain object remains plain Python. Column conventions follow
ADR-025 (NUMERIC money), ADR-026 (UUID pk, ``occurred_on`` DATE, server-managed
timestamps), ADR-027 (``kind`` persisted, ``type`` derived; category and
payment method as plain validated strings) and ADR-029 (nullable FX block).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    false,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class TransactionRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.transaction.Transaction`.

    The ARS-equivalent ``amount`` is authoritative and stored as ``NUMERIC(18,2)``
    (ADR-025); the FX block is nullable and populated only for USD rows (ADR-029).
    ``kind`` is the persisted source of truth — no ``type`` column exists, since
    ``type`` is derived in the domain (ADR-027).
    """

    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    occurred_on: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    usd_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    fx_rate_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fx_rate_as_of: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payment_method: Mapped[str | None] = mapped_column(String(100), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text(), nullable=True)
    recurring: Mapped[bool] = mapped_column(
        Boolean(),
        nullable=False,
        server_default=false(),
    )
    counts_toward_monotributo: Mapped[bool] = mapped_column(
        Boolean(),
        nullable=False,
        server_default=false(),
    )
    statement_document_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("statement_document.id", ondelete="SET NULL"),
        nullable=True,
    )
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
        # Newest-first listing and date-range queries sort on occurred_on (ADR-026).
        Index("ix_transactions_occurred_on", "occurred_on"),
    )
