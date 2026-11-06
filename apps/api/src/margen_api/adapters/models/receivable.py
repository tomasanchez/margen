"""SQLAlchemy persistence models for the receivables domain (ADR-204, ADR-205, ADR-214).

The adapter-layer mappings for the pure domain aggregates at
``margen_api.domain.models.receivable``. SQLAlchemy stays in the adapters (AGENTS.md);
the domain objects remain plain Python. Column conventions mirror ``DebtRecord`` /
``TransactionRecord``: UUID pk via ``gen_random_uuid`` (ADR-026), NUMERIC(18,2) money
(ADR-025), server-managed timestamps, and a NOT NULL ``user_id`` ownership column on the
root :class:`PersonRecord` with no cross-schema FK to Supabase ``auth.users``
(ADR-094, ADR-130); child rows inherit ownership through ``person_id`` (a cuota through
its item) rather than carrying their own ``user_id``.

Crucially, **no table here carries an ``account_id``** — receivables are structurally
excluded from balance and net-worth aggregation (ADR-205), so there is no join path from
these rows into ``account_queries.py`` and no filter to remember. Exactly two FKs reach
outside the receivables subsystem, both into ``transactions.id`` and both ``ON DELETE SET
NULL`` so deleting the transaction orphans the receivable row rather than cascading it
away: ``receivable_payment.matched_income_transaction_id`` (a confirmed income match,
ADR-207) and ``receivable_item.source_transaction_id`` (the reference-only link to the
expense a debt came from, ADR-217/219). Deleting a person cascades to their items and
payments, an item cascades to its installment schedule, and a payment/item/installment
cascades to its allocations (ADR-208, ADR-214, ADR-221).
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
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

    An item may optionally own an installment schedule (:class:`ReceivableInstallmentRecord`
    rows, ADR-214); a flat item owns none and behaves exactly as before. The nullable
    ``source_transaction_id`` optionally points at the expense the debt came from (ADR-217).
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
    # Optional reference link to the EXPENSE this debt came from (ADR-217). Display and
    # traceability metadata only: it never nets the expense out of net worth, budgets or
    # category spend (ADR-219) — reimbursement netting stays ``transactions.offsets_transaction_id``'s
    # job (ADR-159), a deliberately separate mechanism. NOT unique: one shared expense may back
    # many items across different people (ADR-218). ``ON DELETE SET NULL`` so deleting the
    # expense drops only the reference, never the debt record (ADR-223). The same-owner and
    # ``kind='expense'`` checks are application-layer (ADR-130, ADR-217); the FK guarantees only
    # referential integrity. Indexed for the "items linking this transaction" reader (ADR-218,
    # ADR-220) and the SET NULL lookup when a transaction is deleted.
    source_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )


class ReceivableInstallmentRecord(Base):
    """Relational mapping of one cuota in a receivable item's installment schedule (ADR-214).

    An optional child of :class:`ReceivableItemRecord`: an item repaid in installments owns
    ``N`` rows here (``index`` 1..N), a flat item owns none. ``amount`` is ``NUMERIC(18, 2)``
    ARS (ADR-025); the cuota amounts always sum to the parent item's ``amount`` (ADR-216), an
    application-layer invariant rather than a database constraint. ``due_on`` splits
    outstanding into due vs. upcoming (ADR-215). ``pardoned_at`` mirrors the item-level pardon
    (ADR-210) at the cuota grain (ADR-221): non-NULL forgives just this cuota, NULL means it
    is still owed.

    Ownership flows through ``item_id`` → ``receivable_item.person_id`` → ``person.user_id``
    (ADR-130). ``item_id`` is ``ON DELETE CASCADE`` so deleting an item — or, transitively,
    its person — removes its schedule (ADR-208). ``UNIQUE (item_id, index)`` keeps cuota
    numbers distinct within a plan, and its btree (led by ``item_id``) doubles as the
    ``item_id`` FK/lookup index, so no separate single-column index is declared. No
    ``account_id`` (ADR-205).
    """

    __tablename__ = "receivable_installment"
    __table_args__ = (
        # One cuota number per plan. The index behind this constraint leads with ``item_id``,
        # so it also serves every ``item_id`` lookup (fetch a plan ordered by ``index``, the
        # ON DELETE CASCADE scan); a separate ``ix_receivable_installment_item_id`` would be
        # redundant write and vacuum cost.
        UniqueConstraint("item_id", "index", name="uq_receivable_installment_item_id_index"),
    )

    # As for every receivable table, the id is generated client-side by the domain factory and
    # assigned by the repository; the server default is only a raw-SQL fallback, because a
    # server-generated id does not round-trip on the SQLite e2e tier (ADR-223).
    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("receivable_item.id", ondelete="CASCADE"),
        nullable=False,
    )
    # The cuota's 1-based position in its plan. ``index`` is a keyword on SQLite (non-reserved
    # on PostgreSQL): SQLAlchemy quotes it automatically, but raw ``text()`` SQL that must also
    # run on the SQLite e2e tier has to write ``"index"``.
    index: Mapped[int] = mapped_column(Integer(), nullable=False)
    due_on: Mapped[datetime.date] = mapped_column(Date(), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    pardoned_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
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
    ``NUMERIC(18, 2)`` ARS (ADR-025). Every FK uses ``ON DELETE CASCADE`` (indexed) so
    deleting a payment, an item or a cuota removes its allocations — which, combined with the
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
    # The specific cuota this allocation settles when its item has an installment schedule
    # (ADR-221). Nullable: flat items — and every pre-existing allocation — target the item
    # alone, with no backfill (ADR-223). "Required iff the item has a schedule" is a
    # cross-table invariant enforced in the application layer, not by the database (ADR-223).
    # ``item_id`` stays NOT NULL either way, so item-level roll-ups keep working.
    # ``ON DELETE CASCADE``: an allocation to a deleted cuota goes with it.
    installment_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("receivable_installment.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
