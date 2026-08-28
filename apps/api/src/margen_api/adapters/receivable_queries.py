"""SQLAlchemy persistence + reader for the receivables cluster (ADR-204, ADR-206, ADR-130).

The single adapter backing both sides of the receivables aggregate: the write-side
:class:`SqlAlchemyReceivableRepository` (people, items, payments, allocations) and the
read-side :class:`SqlAlchemyReceivableReader` (people list + per-person detail with the
ADR-206 settlement roll-ups). SQLAlchemy stays here (AGENTS.md); the domain aggregates and
read models stay plain Python. Money aggregates are cast to ``NUMERIC(18, 2)`` and coerced
to :class:`~decimal.Decimal` so a SUM round-trips exactly on both PostgreSQL and the
in-memory SQLite test tier (ADR-025/034). All I/O is awaited.

Ownership always flows through the person's ``user_id`` (the only ownership column,
ADR-204): item/payment/allocation reads scope by joining back to the person, and a foreign
owner's id is treated as absent so the boundary answers 404 (ADR-111, ADR-130). Deleting a
person relies on the database ``ON DELETE CASCADE`` FKs to tear down the subtree (ADR-208).
Nothing here joins into ``account_queries`` — receivables never enter net worth (ADR-205).
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableAllocationRecord,
    ReceivableItemRecord,
    ReceivablePaymentRecord,
)
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.receivable import (
    Person,
    ReceivableAllocation,
    ReceivableItem,
    ReceivablePayment,
)
from margen_api.domain.models.value_objects import Kind
from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    PersonReadModel,
    ReceivableItemReadModel,
)
from margen_api.service_layer.receivable_reader import AbstractReceivableReader
from margen_api.service_layer.receivable_repository import AbstractReceivableRepository

_ZERO = Decimal(0)


def _person_to_domain(record: PersonRecord) -> Person:
    """Rehydrate a :class:`Person` from its persisted row (already valid)."""
    return Person(
        id=record.id,
        name=record.name,
        user_id=str(record.user_id),
        created_at=record.created_at,
    )


def _item_to_domain(record: ReceivableItemRecord) -> ReceivableItem:
    """Rehydrate a :class:`ReceivableItem` from its persisted row (already valid)."""
    return ReceivableItem(
        id=record.id,
        person_id=record.person_id,
        occurred_on=record.occurred_on,
        amount=record.amount,
        detail=record.detail,
        created_at=record.created_at,
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
    record.amount = allocation.amount
    return record


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

    def add_item(self, item: ReceivableItem) -> None:
        """Stage a new item; the unit of work flushes it on commit (ADR-204)."""
        self.session.add(_item_record(item))

    async def get_item(self, item_id: UUID, user_id: str) -> ReceivableItem | None:
        """Load one of the owner's items by identity (joined through person), or ``None``."""
        statement = (
            select(ReceivableItemRecord)
            .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
            .where(
                ReceivableItemRecord.id == item_id,
                PersonRecord.user_id == UUID(user_id),
            )
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _item_to_domain(record)

    async def persist_item(self, item: ReceivableItem) -> None:
        """Apply a mutated item to its attached row (update), inserting if absent."""
        record = await self.session.get(ReceivableItemRecord, item.id)
        if record is None:
            # No stored row: treat as an insert so the caller's change is not lost.
            self.session.add(_item_record(item))
            return
        record.occurred_on = item.occurred_on
        record.amount = item.amount
        record.detail = item.detail

    async def delete_item(self, item_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's item row (scoped through person), cascading allocations."""
        statement = (
            select(ReceivableItemRecord)
            .join(PersonRecord, PersonRecord.id == ReceivableItemRecord.person_id)
            .where(
                ReceivableItemRecord.id == item_id,
                PersonRecord.user_id == UUID(user_id),
            )
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
        """Stage one payment-to-item allocation; the unit of work flushes it on commit."""
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

    async def item_remainders(self, person_id: UUID) -> dict[UUID, Decimal]:
        """Return each of the person's items keyed to its outstanding remainder (ADR-206)."""
        allocated = func.coalesce(cast(func.sum(ReceivableAllocationRecord.amount), Numeric(18, 2)), _ZERO)
        statement = (
            select(ReceivableItemRecord.id, ReceivableItemRecord.amount, allocated.label("allocated"))
            .select_from(ReceivableItemRecord)
            .outerjoin(
                ReceivableAllocationRecord,
                ReceivableAllocationRecord.item_id == ReceivableItemRecord.id,
            )
            .where(ReceivableItemRecord.person_id == person_id)
            .group_by(ReceivableItemRecord.id, ReceivableItemRecord.amount)
        )
        rows = (await self.session.execute(statement)).all()
        # The item amount is a NUMERIC column and the allocated total is cast to
        # NUMERIC(18, 2), so SQLAlchemy's type processor yields exact ``Decimal`` on both
        # PostgreSQL and the SQLite test tier (ADR-025/034).
        return {row.id: row.amount - row.allocated for row in rows}


class SqlAlchemyReceivableReader(AbstractReceivableReader):
    """Serve the people list + per-person detail from an async session (ADR-204, ADR-206)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_people(self, user_id: str) -> list[PersonReadModel]:
        """List the owner's people with Σ-item-remainder outstanding, newest-first (ADR-206)."""
        owner = UUID(user_id)
        # Pre-aggregate allocations per item so joining items to the sub-total never
        # double-counts an item's amount across its several allocations (ADR-206).
        allocated_sub = (
            select(
                ReceivableAllocationRecord.item_id.label("item_id"),
                func.sum(ReceivableAllocationRecord.amount).label("allocated"),
            )
            .group_by(ReceivableAllocationRecord.item_id)
            .subquery()
        )
        remainder = ReceivableItemRecord.amount - func.coalesce(allocated_sub.c.allocated, _ZERO)
        outstanding = func.coalesce(cast(func.sum(remainder), Numeric(18, 2)), _ZERO)
        statement = (
            select(
                PersonRecord.id,
                PersonRecord.name,
                PersonRecord.created_at,
                outstanding.label("outstanding"),
            )
            .select_from(PersonRecord)
            .outerjoin(ReceivableItemRecord, ReceivableItemRecord.person_id == PersonRecord.id)
            .outerjoin(allocated_sub, allocated_sub.c.item_id == ReceivableItemRecord.id)
            .where(PersonRecord.user_id == owner)
            .group_by(PersonRecord.id, PersonRecord.name, PersonRecord.created_at)
            .order_by(PersonRecord.created_at.desc(), PersonRecord.id.desc())
        )
        rows = (await self.session.execute(statement)).all()
        return [
            PersonReadModel(
                id=row.id,
                name=row.name,
                created_at=row.created_at,
                outstanding=row.outstanding,
            )
            for row in rows
        ]

    async def get_person(self, person_id: UUID, user_id: str) -> PersonDetailReadModel | None:
        """Load one person with per-item remainders, or ``None`` (ADR-206, ADR-111)."""
        person = (
            await self.session.execute(
                select(PersonRecord).where(
                    PersonRecord.id == person_id,
                    PersonRecord.user_id == UUID(user_id),
                )
            )
        ).scalar_one_or_none()
        if person is None:
            return None
        items = await self._items_with_remainders(person_id)
        outstanding = sum((item.remaining for item in items), _ZERO)
        return PersonDetailReadModel(
            id=person.id,
            name=person.name,
            created_at=person.created_at,
            outstanding=outstanding,
            items=tuple(items),
        )

    async def _items_with_remainders(self, person_id: UUID) -> list[ReceivableItemReadModel]:
        """Project the person's items with their allocated/remaining roll-ups, newest-first."""
        allocated = func.coalesce(cast(func.sum(ReceivableAllocationRecord.amount), Numeric(18, 2)), _ZERO)
        statement = (
            select(
                ReceivableItemRecord.id,
                ReceivableItemRecord.occurred_on,
                ReceivableItemRecord.amount,
                ReceivableItemRecord.detail,
                allocated.label("allocated"),
            )
            .select_from(ReceivableItemRecord)
            .outerjoin(
                ReceivableAllocationRecord,
                ReceivableAllocationRecord.item_id == ReceivableItemRecord.id,
            )
            .where(ReceivableItemRecord.person_id == person_id)
            .group_by(
                ReceivableItemRecord.id,
                ReceivableItemRecord.occurred_on,
                ReceivableItemRecord.amount,
                ReceivableItemRecord.detail,
            )
            .order_by(ReceivableItemRecord.occurred_on.desc(), ReceivableItemRecord.id.desc())
        )
        rows = (await self.session.execute(statement)).all()
        models: list[ReceivableItemReadModel] = []
        for row in rows:
            amount = row.amount
            allocated_amount = row.allocated
            models.append(
                ReceivableItemReadModel(
                    id=row.id,
                    occurred_on=row.occurred_on,
                    amount=amount,
                    detail=row.detail,
                    allocated=allocated_amount,
                    remaining=amount - allocated_amount,
                )
            )
        return models
