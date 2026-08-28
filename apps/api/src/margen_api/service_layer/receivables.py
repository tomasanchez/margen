"""Application handlers for the receivables cluster (ADR-204, ADR-206, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregates through the domain
so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain; the one
policy that spans several rows — the ADR-206 settlement/overpayment guard — is enforced
here at the aggregate root's consistency boundary, reading the person's current remainders
inside the same transaction. Handlers contain no SQLAlchemy (AGENTS.md). Every write is
owner-scoped through the person's ``user_id`` (ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    CreatePerson,
    DeletePerson,
    DeleteReceivableItem,
    EditReceivableItem,
    RecordReceivablePayment,
    RenamePerson,
)
from margen_api.domain.models.exceptions import (
    AllocationExceedsPaymentError,
    IncomeAlreadyClaimedError,
    MatchedIncomeNotFoundError,
    PersonNotFoundError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
)
from margen_api.domain.models.receivable import (
    ReceivableItem,
    build_person,
    build_receivable_allocation,
    build_receivable_item,
    build_receivable_payment,
)
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

_ZERO = Decimal(0)


async def create_person(command: CreatePerson, uow: AbstractUnitOfWork) -> UUID:
    """Create a new person owned by the caller and return its identity (ADR-204, ADR-130).

    The handler injects the UUID identity and ``created_at`` so the domain stays clock-
    and UUID-free in production (ADR-026), then builds the aggregate through the factory so
    the non-empty-name invariant runs (ADR-031). The person is stamped with
    ``command.user_id`` so it is owned from creation (ADR-130).

    Args:
        command: The validated create request.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the newly persisted person.
    """
    person = build_person(
        person_id=uuid4(),
        name=command.name,
        user_id=command.user_id,
        created_at=datetime.now(UTC),
    )
    async with uow:
        uow.receivables.add_person(person)
        await uow.commit()
    return person.id


async def rename_person(command: RenamePerson, uow: AbstractUnitOfWork) -> UUID:
    """Rename one of the caller's people (ADR-204, ADR-130).

    Loads the person by identity scoped to ``user_id`` (a foreign owner's id is not found,
    ADR-111), rebuilds it through the factory with the new name so the invariant re-runs,
    and preserves ``id``, ``created_at`` and ownership.

    Args:
        command: The validated rename request.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the renamed person.

    Raises:
        PersonNotFoundError: When no person matches ``command.id`` for the owner.
    """
    async with uow:
        existing = await uow.receivables.get_person(command.id, command.user_id)
        if existing is None:
            raise PersonNotFoundError(command.id)
        renamed = build_person(
            person_id=existing.id,
            name=command.name,
            user_id=existing.user_id,
            created_at=existing.created_at,
        )
        await uow.receivables.persist_person(renamed)
        await uow.commit()
    return renamed.id


async def delete_person(command: DeletePerson, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a person by identity, cascading their subtree (ADR-204, ADR-208).

    Scoped to ``command.user_id`` so a cross-tenant delete removes nothing and the
    boundary answers 404 (ADR-111). The database cascades the person's items, payments and
    allocations away (ADR-208).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the receivables repository.

    Raises:
        PersonNotFoundError: When no person matches ``command.id`` for the owner.
    """
    async with uow:
        removed = await uow.receivables.delete_person(command.id, command.user_id)
        if not removed:
            raise PersonNotFoundError(command.id)
        await uow.commit()


async def add_receivable_item(command: AddReceivableItem, uow: AbstractUnitOfWork) -> UUID:
    """Add an itemized debt to one of the caller's people (ADR-204, ADR-130).

    Verifies the person exists for the owner (else 404, ADR-111) before building the item
    so an orphan item can never be created, then injects identity/timestamp and builds the
    item through the factory so the positive-amount invariant runs (ADR-031).

    Args:
        command: The validated add-item request.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the newly persisted item.

    Raises:
        PersonNotFoundError: When the target person does not exist for the owner.
    """
    async with uow:
        person = await uow.receivables.get_person(command.person_id, command.user_id)
        if person is None:
            raise PersonNotFoundError(command.person_id)
        item = build_receivable_item(
            item_id=uuid4(),
            person_id=person.id,
            occurred_on=command.occurred_on,
            amount=command.amount,
            detail=command.detail,
            created_at=datetime.now(UTC),
        )
        uow.receivables.add_item(item)
        await uow.commit()
    return item.id


async def edit_receivable_item(command: EditReceivableItem, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to one of the caller's items (ADR-204, ADR-130).

    Loads the item scoped to the owner through its person (a foreign owner's id is not
    found, ADR-111), overlays the present fields (``None`` leaves a field unchanged,
    ADR-028), rebuilds it through the factory so invariants re-run, and preserves
    ``id``, ``person_id`` and ``created_at``.

    Args:
        command: The validated patch request, addressing one item by ``id``.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the updated item.

    Raises:
        ReceivableItemNotFoundError: When no item matches ``command.id`` for the owner.
    """
    async with uow:
        existing = await uow.receivables.get_item(command.id, command.user_id)
        if existing is None:
            raise ReceivableItemNotFoundError(command.id)
        patched = _apply_item_patch(existing, command)
        await uow.receivables.persist_item(patched)
        await uow.commit()
    return patched.id


async def delete_receivable_item(command: DeleteReceivableItem, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a receivable item by identity (ADR-204, ADR-208).

    Scoped to the owner through the item's person so a cross-tenant delete removes nothing
    and the boundary answers 404 (ADR-111). The database cascades the item's allocations
    away (ADR-208).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the receivables repository.

    Raises:
        ReceivableItemNotFoundError: When no item matches ``command.id`` for the owner.
    """
    async with uow:
        removed = await uow.receivables.delete_item(command.id, command.user_id)
        if not removed:
            raise ReceivableItemNotFoundError(command.id)
        await uow.commit()


async def record_receivable_payment(command: RecordReceivablePayment, uow: AbstractUnitOfWork) -> UUID:
    """Record an incoming payback and allocate it across items atomically (ADR-206, ADR-130).

    Enforces the settlement rules at the aggregate root's consistency boundary within one
    transaction:

    1. The person must exist for the owner (else 404, ADR-111).
    2. On the confirm-match path only (``matched_income_transaction_id`` set, ADR-207), the
       linked income must exist, belong to this owner and be ``kind='income'`` (else 404,
       existence never leaked) AND must not already back another payment (else 409, the
       claimed invariant). Manual payments skip this and are unaffected.
    3. Every allocation must target one of that person's items (else 404).
    4. The allocations may not sum to more than the payment's own ``amount`` — a true
       invariant violation (``422``).
    5. When the allocations would drive the person's outstanding below zero, an
       overpayment **warning** is raised unless ``allow_overpayment`` is set, so the API
       layer can confirm the credit rather than silently clamping or going negative.

    Only after every check passes does the handler build and stage the payment and its
    allocations, so a rejected payment leaves no partial rows.

    Args:
        command: The validated record-payment request carrying its allocations.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the newly persisted payment.

    Raises:
        PersonNotFoundError: When the paying person does not exist for the owner.
        MatchedIncomeNotFoundError: When a confirm-match links an income that is missing,
            owned by another user, or not a ``kind='income'`` transaction (ADR-207).
        IncomeAlreadyClaimedError: When a confirm-match links an income that already backs
            one of the owner's payments (the ADR-207 claimed invariant).
        ReceivableItemNotFoundError: When an allocation targets an item that is not one of
            the person's items.
        AllocationExceedsPaymentError: When the allocations sum to more than the payment.
        ReceivableOverpaymentError: When the allocations would overpay the person and
            ``allow_overpayment`` is not set (the confirm-warning path).
    """
    async with uow:
        person = await uow.receivables.get_person(command.person_id, command.user_id)
        if person is None:
            raise PersonNotFoundError(command.person_id)

        if command.matched_income_transaction_id is not None:
            # Confirm-match path only (ADR-207): validate the linked income inside the same
            # transaction, before staging the payment. Manual payments (no matched id) skip
            # this entirely and are unaffected. Mirrors the reimbursement offset-link guard.
            income_id = command.matched_income_transaction_id
            if not await uow.receivables.income_exists_for_owner(income_id, command.user_id):
                # Missing, foreign, or not a kind='income' row all collapse to 404 so the
                # boundary never leaks which case applies (ADR-111).
                raise MatchedIncomeNotFoundError(income_id)
            if await uow.receivables.income_is_claimed(income_id, command.user_id):
                # A confirmed income is claimed and may not settle a second debt (ADR-207).
                raise IncomeAlreadyClaimedError(income_id)

        remainders = await uow.receivables.item_remainders(command.person_id)
        allocated_total = _ZERO
        for allocation in command.allocations:
            if allocation.item_id not in remainders:
                raise ReceivableItemNotFoundError(allocation.item_id)
            allocated_total += allocation.amount

        if allocated_total > command.amount:
            raise AllocationExceedsPaymentError(command.amount, allocated_total)

        outstanding = sum(remainders.values(), _ZERO)
        if allocated_total > outstanding and not command.allow_overpayment:
            raise ReceivableOverpaymentError(command.person_id, outstanding, allocated_total)

        payment = build_receivable_payment(
            payment_id=uuid4(),
            person_id=person.id,
            occurred_on=command.occurred_on,
            amount=command.amount,
            source=command.source,
            matched_income_transaction_id=command.matched_income_transaction_id,
            created_at=datetime.now(UTC),
        )
        uow.receivables.add_payment(payment)
        # Flush the payment BEFORE staging its allocations so the FK
        # (receivable_allocation.payment_id -> receivable_payment.id) is satisfied on
        # FK-enforcing Postgres. The records have no relationship() edge, so the UoW's
        # insert-ordering would otherwise not guarantee the payment lands first; SQLite
        # (FKs off in tests) hid this, real Postgres integration surfaced it.
        await uow.flush()
        for allocation in command.allocations:
            uow.receivables.add_allocation(
                build_receivable_allocation(
                    allocation_id=uuid4(),
                    payment_id=payment.id,
                    item_id=allocation.item_id,
                    amount=allocation.amount,
                )
            )
        await uow.commit()
    return payment.id


def _apply_item_patch(existing: ReceivableItem, command: EditReceivableItem) -> ReceivableItem:
    """Rebuild an item overlaying the patch's present fields (ADR-204, ADR-028).

    Rebuilding through :func:`build_receivable_item` re-runs the domain invariants so the
    patched state is validated and normalized, while preserving identity, ``person_id``
    and ``created_at`` (ADR-026, ADR-031). ``None`` fields leave the current value intact.
    """
    return build_receivable_item(
        item_id=existing.id,
        person_id=existing.person_id,
        occurred_on=command.occurred_on if command.occurred_on is not None else existing.occurred_on,
        amount=command.amount if command.amount is not None else existing.amount,
        detail=command.detail if command.detail is not None else existing.detail,
        created_at=existing.created_at,
    )
