"""SQLAlchemy persistence models for the receivables domain (ADR-204, ADR-205).

The adapter-layer mappings for the pure domain aggregates at
``margen_api.domain.models.receivable``. SQLAlchemy stays in the adapters (AGENTS.md);
the domain objects remain plain Python. Column conventions mirror ``DebtRecord`` /
``TransactionRecord``: UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC(18,2) money
(ADR-025), server-managed timestamps, and a NOT NULL ``user_id`` ownership column on the
root :class:`PersonRecord` with no cross-schema FK to Supabase ``auth.users``
(ADR-094, ADR-130); child rows inherit ownership through ``person_id`` rather than
carrying their own ``user_id``.

Crucially, **no table here carries an ``account_id``** — receivables are structurally
excluded from balance and net-worth aggregation (ADR-205), so there is no join path from
these rows into ``account_queries.py`` and no filter to remember. The only FK that
reaches outside the receivables subsystem is
``receivable_payment.matched_income_transaction_id`` → ``transactions.id`` (a confirmed
income match, ADR-207) with ``ON DELETE SET NULL`` so deleting the income orphans the
payback rather than cascading a settlement record away. Deleting a person cascades to
their items and payments, and a payment/item cascades to its allocations (ADR-208).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Index, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from margen_api.adapters.models.base import Base


class PersonRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.receivable.Person`.

    The receivables aggregate root: a debtor the owner tracks. Carries the NOT NULL
    ``user_id`` ownership column (indexed for owner-scoped reads, ADR-108/130) and NO
    ``account_id`` (ADR-205). Deleting a person cascades to its items and payments via
    their ``ON DELETE CASCADE`` FKs (ADR-208).
    """

    __tablename__ = "person"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Ownership column (ADR-130): every person is owned, so it is NOT NULL. No ForeignKey --
    # auth users live in Supabase's ``auth.users`` schema and the hermetic SQLite e2e tier
    # has no such table (ADR-094). Indexed for the owner-scoped reads (ADR-108/130).
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ReceivableItemRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.receivable.ReceivableItem`.

    One itemized debt owed by a person. ``amount`` is ``NUMERIC(18, 2)`` ARS (ADR-025);
    ``detail`` is the nullable free-text justification (ADR-204). Scoped to its owner
    through ``person_id`` (indexed FK, ``ON DELETE CASCADE`` so deleting the person
    removes their items, ADR-208). No ``account_id`` (ADR-205).

    ``pardoned_at`` is the nullable timestamp of the owner forgiving this item (ADR-210): a
    non-NULL value marks the item as "covered by you" so it drops out of the person's
    outstanding and is rejected as an allocation target, yet stays on the shareable
    statement; NULL means the item is a normal, still-owed debt. Reversible — un-pardoning
    resets it to NULL. No ``account_id`` here either, so a pardon never moves a balance
    (ADR-205).
    """

    __tablename__ = "receivable_item"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("person.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    occurred_on: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text(), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    pardoned_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class ReceivablePaymentRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.receivable.ReceivablePayment`.

    An incoming payback event. ``amount`` is ``NUMERIC(18, 2)`` ARS (ADR-025); ``source``
    is a plain validated string (``manual`` | ``matched_income``, ADR-207). Scoped to its
    owner through ``person_id`` (indexed FK, ``ON DELETE CASCADE``, ADR-208). The nullable
    ``matched_income_transaction_id`` FK → ``transactions.id`` links a confirmed income
    match (ADR-207) with ``ON DELETE SET NULL`` so deleting the income orphans the payback
    rather than cascading it away. A confirmed income is "claimed" and may back at most one
    payment (ADR-207), so ``matched_income_transaction_id`` carries a PARTIAL UNIQUE index
    (``WHERE ... IS NOT NULL``) that both enforces the claimed invariant at the database as
    defense-in-depth behind the handler check AND backs the cheap "income already claimed"
    lookup — while leaving unlimited NULL (manual) paybacks free to coexist. No ``account_id``
    (ADR-205).
    """

    __tablename__ = "receivable_payment"
    __table_args__ = (
        # Partial UNIQUE index enforcing the ADR-207 "claimed" invariant at the database as
        # defense-in-depth behind the handler check: a confirmed income backs at most one
        # payment. ``postgresql_where`` (NULLs excluded) is honored on PostgreSQL and harmlessly
        # ignored on the SQLite e2e tier, where a full unique index still permits unlimited NULL
        # (manual) paybacks because SQLite treats every NULL as distinct.
        Index(
            "uq_receivable_payment_matched_income_transaction_id",
            "matched_income_transaction_id",
            unique=True,
            postgresql_where=text("matched_income_transaction_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("person.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    occurred_on: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    matched_income_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ReceivableAllocationRecord(Base):
    """Relational mapping of a :class:`~margen_api.domain.models.receivable.ReceivableAllocation`.

    The many-to-one join applying a payment across items (ADR-204/206). ``amount`` is
    ``NUMERIC(18, 2)`` ARS (ADR-025). Both FKs use ``ON DELETE CASCADE`` (indexed) so
    deleting a payment or an item removes its allocations — which, combined with the
    person→payment/item cascade, means deleting a person tears down the whole subtree
    (ADR-208). No ``account_id`` (ADR-205).
    """

    __tablename__ = "receivable_allocation"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("receivable_payment.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("receivable_item.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
