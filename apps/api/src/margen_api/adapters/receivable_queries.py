"""SQLAlchemy persistence + reader for the receivables cluster (ADR-204, ADR-206, ADR-130).

The single adapter backing both sides of the receivables aggregate: the write-side
:class:`SqlAlchemyReceivableRepository` (people, items with their cuota schedules, payments,
allocations) and the read-side :class:`SqlAlchemyReceivableReader` (people list, per-person
detail, suggested allocation and the expense link picker). SQLAlchemy stays here
(AGENTS.md); the domain aggregates and read models stay plain Python. Money aggregates are
cast to ``NUMERIC(18, 2)`` so a SUM round-trips as an exact :class:`~decimal.Decimal` on both
PostgreSQL and the in-memory SQLite test tier (ADR-025/034). All I/O is awaited.

The settlement figures (remaining, due outstanding, upcoming, per-cuota status) are NOT
computed in SQL: both sides load the items with their schedules plus the allocation sums and
hand them to the pure :mod:`~margen_api.domain.models.receivable_settlement` policy, so the
overpayment guard and every read agree on what is owed as of a date (ADR-206, ADR-215).

Ownership always flows through the person's ``user_id`` (the only ownership column,
ADR-204): item/cuota/payment/allocation reads scope by joining back to the person, and a
foreign owner's id is treated as absent so the boundary answers 404 (ADR-111, ADR-130).
Deleting a person or item relies on the database ``ON DELETE CASCADE`` FKs to tear down the
subtree (ADR-208); re-scheduling deletes the replaced cuota rows explicitly. Writes are
serialized per person by :meth:`SqlAlchemyReceivableRepository.lock_person`
(``SELECT ... FOR UPDATE`` on PostgreSQL; SQLite has no row locks and ignores it). Identities are
generated client-side and assigned here, never left to the server default (ADR-223). Nothing
here joins into ``account_queries`` — receivables never enter net worth (ADR-205); the
expense link only reads the linked transaction for display (ADR-219).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import ColumnElement, Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableAllocationRecord,
    ReceivableInstallmentRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.receivable import (
    Person,
    ReceivableAllocation,
    ReceivableInstallment,
    ReceivableItem,
    ReceivablePayment,
)
from margen_api.domain.models.receivable_settlement import (
    NO_ALLOCATIONS,
    InstallmentPosition,
    ItemAllocations,
    ItemPosition,
    assess_item,
    default_allocation,
    person_outstanding,
    person_upcoming,
)
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.receivable_read_models import (
    ExpenseCandidateReadModel,
    PersonDetailReadModel,
    PersonReadModel,
    ReceivableInstallmentReadModel,
    ReceivableItemReadModel,
    ReceivablePaymentReadModel,
    SourceTransactionReadModel,
    SuggestedAllocationLineReadModel,
    SuggestedAllocationReadModel,
)
from margen_api.service_layer.receivable_reader import AbstractReceivableReader
from margen_api.service_layer.receivable_repository import AbstractReceivableRepository

_ZERO = Decimal(0)

log = logging.getLogger(__name__)


def _person_to_domain(record: PersonRecord) -> Person:
    """Rehydrate a :class:`Person` from its persisted row (already valid)."""
    return Person(
        id=record.id,
        name=record.name,
        user_id=str(record.user_id),
        created_at=record.created_at,
    )


def _installment_to_domain(record: ReceivableInstallmentRecord) -> ReceivableInstallment:
    """Rehydrate a :class:`ReceivableInstallment` from its persisted row (already valid)."""
    return ReceivableInstallment(
        id=record.id,
        item_id=record.item_id,
        index=record.index,
        due_on=record.due_on,
        amount=record.amount,
        pardoned_at=record.pardoned_at,
        created_at=record.created_at,
    )


def _item_to_domain(
    record: ReceivableItemRecord,
    installments: Sequence[ReceivableInstallment] = (),
) -> ReceivableItem:
    """Rehydrate a :class:`ReceivableItem`, with its cuota schedule, from persisted rows.

    The cuotas are the source of truth for an installment item's amount (ADR-216). Should the
    stored amount ever disagree with them (a row written outside the app, or before writes were
    serialized), the cuota sum is used and the mismatch logged, so one inconsistent row can
    never fail the whole Owed tab; the next write of the item stores the repaired amount.
    """
    amount = record.amount
    cuota_total = sum((installment.amount for installment in installments), _ZERO)
    if installments and cuota_total != amount:
        log.warning(
            "Receivable item %s stores amount %s but its cuotas sum to %s; using the cuota sum.",
            record.id,
            amount,
            cuota_total,
        )
        amount = cuota_total
    return ReceivableItem(
        id=record.id,
        person_id=record.person_id,
        occurred_on=record.occurred_on,
        amount=amount,
        detail=record.detail,
        created_at=record.created_at,
        pardoned_at=record.pardoned_at,
        source_transaction_id=record.source_transaction_id,
        installments=tuple(installments),
    )


def _person_record(person: Person) -> PersonRecord:
    """Build a fresh :class:`PersonRecord` from a domain person (insert).

    Raises:
        ValueError: When the person carries no owning ``user_id`` — every write path
            threads the authenticated owner (ADR-130), so a missing id is a programming
            error rather than a persistable state.
    """
    if person.user_id is None:
        msg = "Cannot persist a person without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record = PersonRecord()
    record.id = person.id
    record.user_id = UUID(person.user_id)
    record.name = person.name
    record.created_at = person.created_at
    return record


def _item_record(item: ReceivableItem) -> ReceivableItemRecord:
    """Build a fresh :class:`ReceivableItemRecord` from a domain item (insert)."""
    record = ReceivableItemRecord()
    record.id = item.id
    record.person_id = item.person_id
    record.occurred_on = item.occurred_on
    record.amount = item.amount
    record.detail = item.detail
    record.created_at = item.created_at
    record.pardoned_at = item.pardoned_at
    record.source_transaction_id = item.source_transaction_id
    return record


def _installment_record(installment: ReceivableInstallment) -> ReceivableInstallmentRecord:
    """Build a fresh :class:`ReceivableInstallmentRecord` from a domain cuota (insert).

    The id is the client-generated domain identity: a server-default id does not round-trip
    on the SQLite e2e tier (ADR-223).
    """
    record = ReceivableInstallmentRecord()
    record.id = installment.id
    record.item_id = installment.item_id
    record.index = installment.index
    record.due_on = installment.due_on
    record.amount = installment.amount
    record.pardoned_at = installment.pardoned_at
    record.created_at = installment.created_at
    return record


def _payment_record(payment: ReceivablePayment) -> ReceivablePaymentRecord:
    """Build a fresh :class:`ReceivablePaymentRecord` from a domain payment (insert)."""
    record = ReceivablePaymentRecord()
    record.id = payment.id
    record.person_id = payment.person_id
    record.occurred_on = payment.occurred_on
    record.amount = payment.amount
    record.source = payment.source.value
    record.matched_income_transaction_id = payment.matched_income_transaction_id
    record.created_at = payment.created_at
    return record


def _allocation_record(allocation: ReceivableAllocation) -> ReceivableAllocationRecord:
    """Build a fresh :class:`ReceivableAllocationRecord` from a domain allocation (insert)."""
    record = ReceivableAllocationRecord()
    record.id = allocation.id
    record.payment_id = allocation.payment_id
    record.item_id = allocation.item_id
    record.installment_id = allocation.installment_id
    record.amount = allocation.amount
    return record


async def _load_items(session: AsyncSession, *criteria: ColumnElement[bool]) -> list[ReceivableItem]:
    """Load the items matching ``criteria`` with their cuota schedules, newest-first.

    ``criteria`` may reference :class:`ReceivableItemRecord` or the joined
    :class:`PersonRecord` (for owner scoping). Ordered by ``occurred_on`` then id, both
    descending — the order the person detail lists items in.
    """
    statement = (
        select(ReceivableItemRecord)
        .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
        .where(*criteria)
        .order_by(ReceivableItemRecord.occurred_on.desc(), ReceivableItemRecord.id.desc())
    )
    records = (await session.execute(statement)).scalars().all()
    schedules = await _load_schedules(session, *criteria)
    return [_item_to_domain(record, schedules.get(record.id, ())) for record in records]


async def _load_schedules(
    session: AsyncSession,
    *criteria: ColumnElement[bool],
) -> dict[UUID, list[ReceivableInstallment]]:
    """Load the cuotas of the items matching ``criteria``, grouped by item id (ADR-214)."""
    statement = (
        select(ReceivableInstallmentRecord)
        .join(ReceivableItemRecord, ReceivableItemRecord.id == ReceivableInstallmentRecord.item_id)
        .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
        .where(*criteria)
    )
    schedules: dict[UUID, list[ReceivableInstallment]] = defaultdict(list)
    for record in (await session.execute(statement)).scalars():
        schedules[record.item_id].append(_installment_to_domain(record))
    return schedules


async def _load_allocations(session: AsyncSession, *criteria: ColumnElement[bool]) -> dict[UUID, ItemAllocations]:
    """Sum the allocations of the items matching ``criteria``, per item and per cuota (ADR-206, ADR-221)."""
    allocated = cast(func.sum(ReceivableAllocationRecord.amount), Numeric(18, 2))
    statement = (
        select(
            ReceivableAllocationRecord.item_id,
            ReceivableAllocationRecord.installment_id,
            allocated.label("allocated"),
        )
        .join(ReceivableItemRecord, ReceivableItemRecord.id == ReceivableAllocationRecord.item_id)
        .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
        .where(*criteria)
        .group_by(ReceivableAllocationRecord.item_id, ReceivableAllocationRecord.installment_id)
    )
    totals: dict[UUID, Decimal] = defaultdict(lambda: _ZERO)
    per_installment: dict[UUID, dict[UUID, Decimal]] = defaultdict(dict)
    for row in (await session.execute(statement)).all():
        totals[row.item_id] += row.allocated
        if row.installment_id is not None:
            per_installment[row.item_id][row.installment_id] = row.allocated
    return {
        item_id: ItemAllocations(total=total, by_installment=per_installment.get(item_id, {}))
        for item_id, total in totals.items()
    }


class SqlAlchemyReceivableRepository(AbstractReceivableRepository):
    """Persist the receivables cluster through an async session (ADR-204, ADR-130)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the repository.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    def add_person(self, person: Person) -> None:
        """Stage a new person; the unit of work flushes it on commit (ADR-130)."""
        self.session.add(_person_record(person))

    async def get_person(self, person_id: UUID, user_id: str) -> Person | None:
        """Load one of the owner's people by identity, or ``None`` (ADR-130, ADR-111)."""
        statement = select(PersonRecord).where(
            PersonRecord.id == person_id,
            PersonRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _person_to_domain(record)

    async def lock_person(self, person_id: UUID, user_id: str) -> Person | None:
        """Load the owner's person with ``SELECT ... FOR UPDATE``, serializing its writes (ADR-130).

        On PostgreSQL the row lock is held until the unit of work commits or rolls back, so a
        concurrent write on the same person waits here and then reads committed state. SQLite
        has no row locks; SQLAlchemy omits the clause there and the call is a plain load.
        """
        statement = (
            select(PersonRecord)
            .where(PersonRecord.id == person_id, PersonRecord.user_id == UUID(user_id))
            .with_for_update()
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _person_to_domain(record)

    async def persist_person(self, person: Person) -> None:
        """Apply a renamed person to its attached row (update), inserting if absent."""
        record = await self.session.get(PersonRecord, person.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(_person_record(person))
            return
        record.name = person.name

    async def delete_person(self, person_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's person row, cascading the subtree in the DB (ADR-208)."""
        statement = select(PersonRecord).where(
            PersonRecord.id == person_id,
            PersonRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True

    async def add_item(self, item: ReceivableItem) -> None:
        """Stage a new item and its cuota schedule; the unit of work flushes them on commit (ADR-214)."""
        self.session.add(_item_record(item))
        if item.installments:
            # Flush the item BEFORE staging its cuotas so receivable_installment.item_id ->
            # receivable_item.id resolves on FK-enforcing PostgreSQL: the records share no
            # relationship() edge, so the unit of work would not order the inserts (mirrors
            # the record-payment flush).
            await self.session.flush()
            self.session.add_all([_installment_record(installment) for installment in item.installments])

    async def get_item(self, item_id: UUID, user_id: str) -> ReceivableItem | None:
        """Load one of the owner's items with its schedule (joined through person), or ``None``."""
        items = await _load_items(
            self.session,
            ReceivableItemRecord.id == item_id,
            PersonRecord.user_id == UUID(user_id),
        )
        return items[0] if items else None

    async def persist_item(self, item: ReceivableItem) -> None:
        """Apply a mutated item and its schedule to the attached rows (update), inserting if absent."""
        record = await self.session.get(ReceivableItemRecord, item.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            await self.add_item(item)
            return
        record.occurred_on = item.occurred_on
        record.amount = item.amount
        record.detail = item.detail
        record.pardoned_at = item.pardoned_at
        record.source_transaction_id = item.source_transaction_id
        await self._sync_schedule(item)

    async def _sync_schedule(self, item: ReceivableItem) -> None:
        """Make the stored cuota rows match the item's schedule (ADR-214, ADR-216).

        Kept cuotas (same id) are updated in place, new ones inserted, and the stored ones the
        item no longer carries — a re-schedule or a conversion back to a flat item — deleted
        explicitly rather than left to a cascade.
        """
        statement = select(ReceivableInstallmentRecord).where(ReceivableInstallmentRecord.item_id == item.id)
        stored = {record.id: record for record in (await self.session.execute(statement)).scalars()}
        kept = {installment.id for installment in item.installments}
        removed = [record for record_id, record in stored.items() if record_id not in kept]
        for record in removed:
            await self.session.delete(record)
        if removed:
            # A flush runs its INSERTs before its DELETEs, so a re-schedule re-using indexes
            # 1..N would trip UNIQUE (item_id, index) unless the old cuotas are gone first.
            await self.session.flush()
        for installment in item.installments:
            existing = stored.get(installment.id)
            if existing is None:
                self.session.add(_installment_record(installment))
                continue
            existing.index = installment.index
            existing.due_on = installment.due_on
            existing.amount = installment.amount
            existing.pardoned_at = installment.pardoned_at

    async def delete_item(self, item_id: UUID, person_id: UUID) -> bool:
        """Hard-delete the person's item row, cascading its cuotas and allocations (ADR-208).

        The person was locked (and so owner-verified) by the handler, so scoping by it keeps the
        delete owner-safe (ADR-130) while refusing another person's item.
        """
        statement = select(ReceivableItemRecord).where(
            ReceivableItemRecord.id == item_id,
            ReceivableItemRecord.person_id == person_id,
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return False
        await self.session.delete(record)
        return True

    def add_payment(self, payment: ReceivablePayment) -> None:
        """Stage a new payback event; the unit of work flushes it on commit (ADR-204)."""
        self.session.add(_payment_record(payment))

    def add_allocation(self, allocation: ReceivableAllocation) -> None:
        """Stage one payment-to-item (or -cuota) allocation; the unit of work flushes it on commit."""
        self.session.add(_allocation_record(allocation))

    async def income_exists_for_owner(self, income_id: UUID, user_id: str) -> bool:
        """Return whether the caller owns a ``kind='income'`` transaction with that id (ADR-207)."""
        statement = select(TransactionRecord.id).where(
            TransactionRecord.id == income_id,
            TransactionRecord.user_id == UUID(user_id),
            TransactionRecord.kind == Kind.INCOME.value,
        )
        return (await self.session.execute(statement)).scalar_one_or_none() is not None

    async def income_is_claimed(self, income_id: UUID, user_id: str) -> bool:
        """Return whether an income already backs one of the owner's payments (ADR-207, ADR-130)."""
        statement = (
            select(ReceivablePaymentRecord.id)
            .join(PersonRecord, PersonRecord.id == ReceivablePaymentRecord.person_id)
            .where(
                PersonRecord.user_id == UUID(user_id),
                ReceivablePaymentRecord.matched_income_transaction_id == income_id,
            )
        )
        return (await self.session.execute(statement)).first() is not None

    async def expense_exists_for_owner(self, transaction_id: UUID, user_id: str) -> bool:
        """Return whether the caller owns a ``kind='expense'`` transaction with that id (ADR-217)."""
        statement = select(TransactionRecord.id).where(
            TransactionRecord.id == transaction_id,
            TransactionRecord.user_id == UUID(user_id),
            TransactionRecord.kind == Kind.EXPENSE.value,
        )
        return (await self.session.execute(statement)).scalar_one_or_none() is not None

    async def item_exists(self, item_id: UUID) -> bool:
        """Return whether any receivable item, of any owner, uses this id (ADR-204)."""
        statement = select(ReceivableItemRecord.id).where(ReceivableItemRecord.id == item_id)
        return (await self.session.execute(statement)).scalar_one_or_none() is not None

    async def list_items(self, person_id: UUID) -> list[ReceivableItem]:
        """Return every item of the person with its schedule (ADR-206, ADR-214)."""
        return await _load_items(self.session, ReceivableItemRecord.person_id == person_id)

    async def allocated_amounts(self, person_id: UUID) -> dict[UUID, ItemAllocations]:
        """Return the allocation sums of the person's items, per item and per cuota (ADR-206, ADR-221)."""
        return await _load_allocations(self.session, ReceivableItemRecord.person_id == person_id)


def _installment_read_model(position: InstallmentPosition) -> ReceivableInstallmentReadModel:
    """Project a cuota position into its read model (ADR-215)."""
    installment = position.installment
    return ReceivableInstallmentReadModel(
        id=installment.id,
        index=installment.index,
        due_on=installment.due_on,
        amount=installment.amount,
        paid=position.paid,
        remaining=position.remaining,
        pardoned=installment.pardoned,
        status=position.status,
    )


def _item_read_model(
    position: ItemPosition,
    sources: Mapping[UUID, SourceTransactionReadModel],
) -> ReceivableItemReadModel:
    """Project an item position, with its linked expense summary, into its read model (ADR-206, ADR-217)."""
    item = position.item
    source = sources.get(item.source_transaction_id) if item.source_transaction_id is not None else None
    return ReceivableItemReadModel(
        id=item.id,
        occurred_on=item.occurred_on,
        amount=item.amount,
        detail=item.detail,
        allocated=position.allocated,
        remaining=position.remaining,
        pardoned=position.pardoned,
        due_outstanding=position.due_outstanding,
        upcoming_total=position.upcoming_total,
        installments=tuple(_installment_read_model(cuota) for cuota in position.installments),
        source_transaction=source,
        linked_total_exceeds_expense=source is not None and source.over_linked,
    )


class SqlAlchemyReceivableReader(AbstractReceivableReader):
    """Serve the receivables query side from an async session (ADR-204, ADR-206, ADR-220)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_people(self, user_id: str, *, as_of: date) -> list[PersonReadModel]:
        """List the owner's people with due-only outstanding and upcoming totals, newest-first (ADR-215)."""
        owner = UUID(user_id)
        statement = (
            select(PersonRecord)
            .where(PersonRecord.user_id == owner)
            .order_by(PersonRecord.created_at.desc(), PersonRecord.id.desc())
        )
        people = (await self.session.execute(statement)).scalars().all()
        by_person: dict[UUID, list[ItemPosition]] = defaultdict(list)
        for position in await self._positions(as_of, PersonRecord.user_id == owner):
            by_person[position.item.person_id].append(position)
        # A person whose items are all pardoned (or who has none) still lists, at zero (ADR-210).
        return [
            PersonReadModel(
                id=person.id,
                name=person.name,
                created_at=person.created_at,
                outstanding=person_outstanding(by_person[person.id]),
                upcoming_total=person_upcoming(by_person[person.id]),
            )
            for person in people
        ]

    async def get_person(self, person_id: UUID, user_id: str, *, as_of: date) -> PersonDetailReadModel | None:
        """Load one person with per-item and per-cuota roll-ups as of a date, or ``None`` (ADR-206, ADR-215)."""
        owner = UUID(user_id)
        person = await self._owned_person(person_id, owner)
        if person is None:
            return None
        positions = await self._positions(as_of, ReceivableItemRecord.person_id == person_id)
        linked = {
            position.item.source_transaction_id
            for position in positions
            if position.item.source_transaction_id is not None
        }
        sources = await self._source_transactions(owner, linked)
        payments = await self._payments(person_id)
        # Pardoned items/cuotas and not-yet-due cuotas are excluded from the authoritative
        # outstanding (ADR-210, ADR-215), though every item is still returned for display.
        return PersonDetailReadModel(
            id=person.id,
            name=person.name,
            created_at=person.created_at,
            outstanding=person_outstanding(positions),
            items=tuple(_item_read_model(position, sources) for position in positions),
            payments=tuple(payments),
            upcoming_total=person_upcoming(positions),
        )

    async def suggest_allocation(
        self,
        person_id: UUID,
        user_id: str,
        *,
        amount: Decimal,
        as_of: date,
    ) -> SuggestedAllocationReadModel | None:
        """Spread ``amount`` over what the person owes as of a date, the ADR-221 default."""
        if await self._owned_person(person_id, UUID(user_id)) is None:
            return None
        suggestion = default_allocation(
            await self._positions(as_of, ReceivableItemRecord.person_id == person_id),
            amount,
        )
        return SuggestedAllocationReadModel(
            as_of=as_of,
            amount=amount,
            lines=tuple(
                SuggestedAllocationLineReadModel(
                    item_id=line.item_id,
                    installment_id=line.installment_id,
                    amount=line.amount,
                )
                for line in suggestion.lines
            ),
            allocated=suggestion.allocated,
            unallocated=suggestion.unallocated,
        )

    async def search_expense_candidates(
        self,
        user_id: str,
        *,
        query: str | None,
        date_from: date | None,
        date_to: date | None,
        limit: int,
    ) -> list[ExpenseCandidateReadModel]:
        """Search the owner's expenses for the receivable link picker, newest first (ADR-220)."""
        owner = UUID(user_id)
        predicates: list[ColumnElement[bool]] = [
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.EXPENSE.value,
        ]
        if query:
            predicates.append(TransactionRecord.name.icontains(query, autoescape=True))
        if date_from is not None:
            predicates.append(TransactionRecord.occurred_on >= date_from)
        if date_to is not None:
            predicates.append(TransactionRecord.occurred_on <= date_to)
        statement = (
            select(
                TransactionRecord.id,
                TransactionRecord.name,
                TransactionRecord.occurred_on,
                TransactionRecord.amount,
                TransactionRecord.currency,
                TransactionRecord.usd_amount,
                TransactionRecord.installments_index,
                TransactionRecord.installments_total,
            )
            .where(*predicates)
            .order_by(
                TransactionRecord.occurred_on.desc(),
                TransactionRecord.created_at.desc(),
                TransactionRecord.id.desc(),
            )
            .limit(limit)
        )
        rows = (await self.session.execute(statement)).all()
        linked = await self._linked_item_totals(owner, {row.id for row in rows})
        return [
            ExpenseCandidateReadModel(
                id=row.id,
                name=row.name,
                occurred_on=row.occurred_on,
                amount=row.amount,
                currency=Currency.parse(row.currency),
                usd_amount=row.usd_amount,
                installments_index=row.installments_index,
                installments_total=row.installments_total,
                linked_items_total=linked.get(row.id, _ZERO),
            )
            for row in rows
        ]

    async def _owned_person(self, person_id: UUID, owner: UUID) -> PersonRecord | None:
        """Return the owner's person row, or ``None`` for an unknown/foreign id (ADR-111)."""
        statement = select(PersonRecord).where(PersonRecord.id == person_id, PersonRecord.user_id == owner)
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def _positions(self, as_of: date, *criteria: ColumnElement[bool]) -> list[ItemPosition]:
        """Assess the items matching ``criteria`` as of a date, newest-first (ADR-206, ADR-215)."""
        items = await _load_items(self.session, *criteria)
        allocations = await _load_allocations(self.session, *criteria)
        return [assess_item(item, allocations.get(item.id, NO_ALLOCATIONS), as_of) for item in items]

    async def _source_transactions(
        self,
        owner: UUID,
        transaction_ids: set[UUID],
    ) -> dict[UUID, SourceTransactionReadModel]:
        """Summarize the owner's linked expenses by id (ADR-217, ADR-218).

        Read-only display data: the expense rows are only read, never re-aggregated (ADR-219).
        A link whose transaction is gone (or not the owner's) simply has no summary.
        """
        if not transaction_ids:
            return {}
        statement = select(
            TransactionRecord.id,
            TransactionRecord.name,
            TransactionRecord.occurred_on,
            TransactionRecord.amount,
            TransactionRecord.currency,
            TransactionRecord.usd_amount,
            TransactionRecord.installments_index,
            TransactionRecord.installments_total,
        ).where(TransactionRecord.id.in_(transaction_ids), TransactionRecord.user_id == owner)
        rows = (await self.session.execute(statement)).all()
        linked = await self._linked_item_totals(owner, transaction_ids)
        return {
            row.id: SourceTransactionReadModel(
                id=row.id,
                name=row.name,
                occurred_on=row.occurred_on,
                amount=row.amount,
                currency=Currency.parse(row.currency),
                usd_amount=row.usd_amount,
                installments_index=row.installments_index,
                installments_total=row.installments_total,
                linked_items_total=linked.get(row.id, _ZERO),
            )
            for row in rows
        }

    async def _linked_item_totals(self, owner: UUID, transaction_ids: set[UUID]) -> dict[UUID, Decimal]:
        """Sum, per expense, the amounts of all the owner's items linking it — across people (ADR-218)."""
        if not transaction_ids:
            return {}
        linked = cast(func.sum(ReceivableItemRecord.amount), Numeric(18, 2))
        statement = (
            select(ReceivableItemRecord.source_transaction_id, linked.label("linked"))
            .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
            .where(
                PersonRecord.user_id == owner,
                ReceivableItemRecord.source_transaction_id.in_(transaction_ids),
            )
            .group_by(ReceivableItemRecord.source_transaction_id)
        )
        return {row.source_transaction_id: row.linked for row in (await self.session.execute(statement)).all()}

    async def _payments(self, person_id: UUID) -> list[ReceivablePaymentReadModel]:
        """Project the person's paybacks (date + amount), newest-first (ADR-206, ADR-209).

        Returns ALL of the person's payments regardless of ``source`` — manual paybacks and
        confirmed income matches alike, since both are real money received. The person was
        already owner-scoped by :meth:`get_person`, so scoping by ``person_id`` here keeps the
        query owner-safe (ADR-130) without re-joining ownership.
        """
        statement = (
            select(ReceivablePaymentRecord.occurred_on, ReceivablePaymentRecord.amount)
            .where(ReceivablePaymentRecord.person_id == person_id)
            .order_by(ReceivablePaymentRecord.occurred_on.desc(), ReceivablePaymentRecord.id.desc())
        )
        rows = (await self.session.execute(statement)).all()
        return [ReceivablePaymentReadModel(occurred_on=row.occurred_on, amount=row.amount) for row in rows]
