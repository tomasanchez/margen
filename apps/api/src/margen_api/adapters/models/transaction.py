"""SQLAlchemy persistence model for the ``Transaction`` aggregate.

This is the adapter-layer mapping for the pure domain aggregate at
``margen_api.domain.models.transaction``. SQLAlchemy stays in the adapters
(AGENTS.md); the domain object remains plain Python. Column conventions follow
ADR-025 (NUMERIC money), ADR-026 (UUID pk, ``occurred_on`` DATE, server-managed
timestamps), ADR-027 (``kind`` persisted, ``type`` derived; category and
payment method as plain validated strings), ADR-029 (nullable FX block) and
ADR-117 (``payment_method`` holds the normalized bank; ``card`` is the optional
display-only card / detail label).
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
    text,
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
    # Ownership column (ADR-094): every write path now sets it, so it is NOT NULL
    # (ADR-109; enforced in PROD only after the backfill script fills legacy NULLs).
    # No ForeignKey -- auth users live in Supabase's ``auth.users`` schema and the
    # hermetic SQLite e2e tier has no such table, so a cross-schema FK would break
    # both migrations and tests. Indexed for the owner-scoped reads (ADR-107/108).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    occurred_on: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    usd_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    # The FX snapshot's rate provenance (ADR-148): a short token for the source the
    # client used to capture the rate (e.g. ``'bolsa'``, ``'mep'``, ``'oficial'``,
    # ``'manual'``, ``'backfill'``). Distinct from ``fx_rate_type`` (ADR-029): the
    # snapshot ``fx_source`` is the per-row provenance the client supplies on write,
    # while ``fx_rate_type`` is the legacy rate family. Nullable: rows without a
    # snapshot (pre-backfill, statement imports pending rate-fill) carry ``None``.
    fx_source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fx_rate_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fx_rate_as_of: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # ``payment_method`` now holds the NORMALIZED bank (JSON ``bank``); the card /
    # detail label is split into the optional ``card`` column (JSON ``card``,
    # display-only, ADR-117).
    payment_method: Mapped[str | None] = mapped_column(String(100), nullable=True)
    card: Mapped[str | None] = mapped_column(String(100), nullable=True)
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
    # The owning account (ADR-122). Nullable: introduced nullable so the accounts
    # migration can add the column then backfill it from the bank tag (ADR-124);
    # ``ondelete=SET NULL`` so deleting an account orphans its transactions rather
    # than cascading the delete. A user may only link a transaction to one of their
    # own accounts -- enforced at the application layer (ADR-130), not by the FK,
    # since the FK cannot express ownership.
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # The offset link for a reimbursement (ADR-159): a nullable SELF-FK to the
    # EXPENSE this payback reduces. Populated only for ``kind='reimbursement'`` rows
    # (the domain forces it NULL for every other kind); NULL everywhere else. A
    # ``ondelete=SET NULL`` orphans a payback rather than cascading when the source
    # expense is deleted. The target-exists / same-owner / is-expense checks are an
    # application-layer concern (ADR-130); the FK only guarantees referential
    # integrity, not ownership. Indexed (partial, WHERE kind='reimbursement') so the
    # net-spend join is cheap (ADR-160).
    offsets_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="SET NULL"),
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
        # A partial index over the reimbursement offset link so the net-spend join
        # (ADR-160) reads only the payback rows. ``postgresql_where`` is honored on
        # PostgreSQL and harmlessly ignored on the SQLite e2e tier.
        Index(
            "ix_transactions_offsets_transaction_id",
            "offsets_transaction_id",
            postgresql_where=text("kind = 'reimbursement'"),
        ),
    )
