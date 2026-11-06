"""Application handlers for the receivables cluster (ADR-204, ADR-206, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregates through the domain
so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain: the cuota
schedule and its edit/pardon/lock rules on :class:`ReceivableItem` (ADR-214/216/221), and
the as-of settlement policy in :mod:`~margen_api.domain.models.receivable_settlement`
(ADR-206/215). The one policy that spans several rows — the ADR-206 settlement/overpayment
guard — is enforced here at the aggregate root's consistency boundary, reading the person's
items and allocations inside the same transaction. Handlers contain no SQLAlchemy
(AGENTS.md). Every write is owner-scoped through the person's ``user_id`` (ADR-130).

Every item, cuota and payment write first locks the person it addresses (the aggregate root,
``lock_person``), so writes on one person's receivables are serialized: a check such as "has
this plan been paid?" or "is this an overpayment?" stays true until the handler commits, and
no write is computed from a stale snapshot. Items are then loaded scoped to that person, so a
URL pairing a person with another person's item is a not-found rather than a stray write.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    CreatePerson,
    DeletePerson,
    DeleteReceivableItem,
    EditReceivableInstallment,
    EditReceivableItem,
    RecordReceivablePayment,
    RenamePerson,
    SetReceivableInstallmentPardon,
    SetReceivableItemPardon,
)
from margen_api.domain.models.exceptions import (
    AllocationExceedsPaymentError,
    AllocationExceedsTargetError,
    IncomeAlreadyClaimedError,
    MatchedIncomeNotFoundError,
    PersonNotFoundError,
    ReceivableItemConflictError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
    SourceTransactionNotFoundError,
)
from margen_api.domain.models.receivable import (
    InstallmentPlan,
    Person,
    ReceivableItem,
    build_person,
    build_receivable_allocation,
    build_receivable_item,
    build_receivable_payment,
)
from margen_api.domain.models.receivable_settlement import (
    NO_ALLOCATIONS,
    ItemPosition,
    assess_item,
    find_target_overrun,
    person_outstanding,
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
    """Add an itemized debt — flat or split into cuotas — to one of the caller's people (ADR-204, ADR-214).

    Locks the person first (else 404, ADR-111), so an orphan item can never be created and the
    write is serialized with every other write on that person. The item is built through the
    factory so the positive-amount and schedule invariants run (ADR-031, ADR-216): with a plan
    it gets its cuota schedule — the even split, then the requested per-cuota tweaks, all in
    this one transaction — and its amount is the resulting schedule's exact sum.

    With a client-chosen ``item_id`` the creation is idempotent: when that id already names an
    item of this person with the same terms, nothing is written and its id is returned (a
    retried request); when the id is used with other terms, or by another person's or owner's
    item, the request is a conflict. Otherwise the optional expense link is validated
    (ADR-217) and the item is staged.

    Args:
        command: The validated add-item request.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the created (or replayed) item.

    Raises:
        PersonNotFoundError: When the target person does not exist for the owner.
        ReceivableItemConflictError: When ``item_id`` is already used with other terms.
        SourceTransactionNotFoundError: When the linked expense is missing, foreign or not
            an expense.
        InvalidInstallmentScheduleError: When the amount cannot be split into the plan or a
            cuota tweak names a cuota the plan does not have (or one twice).
        InvalidAmountError: When a cuota tweak's amount rounds to zero cents.
    """
    async with uow:
        person = await _locked_person(uow, command.person_id, command.user_id)
        installments = command.installments
        item = build_receivable_item(
            item_id=command.item_id if command.item_id is not None else uuid4(),
            person_id=person.id,
            occurred_on=command.occurred_on,
            amount=command.amount,
            detail=command.detail,
            created_at=datetime.now(UTC),
            source_transaction_id=command.source_transaction_id,
            plan=installments.to_plan() if installments is not None else None,
            adjustments=installments.to_adjustments() if installments is not None else (),
            new_installment_id=uuid4,
        )
        if command.item_id is not None:
            existing = await uow.receivables.get_item(command.item_id, command.user_id)
            if existing is not None and existing.has_same_terms(item):
                # A retried creation: the item is already there exactly as requested.
                return existing.id
            if existing is not None or await uow.receivables.item_exists(command.item_id):
                raise ReceivableItemConflictError(command.item_id)
        if command.source_transaction_id is not None:
            await _check_source_expense(uow, command.source_transaction_id, command.user_id)
        await uow.receivables.add_item(item)
        await uow.commit()
    return item.id


async def edit_receivable_item(command: EditReceivableItem, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to one of the caller's items (ADR-204, ADR-216, ADR-217, ADR-130).

    Locks the person, then loads the item scoped to the owner and that person (a foreign or
    mismatched id is not found, ADR-111) and overlays the present fields (``None`` leaves a
    field unchanged, ADR-028). An expense link that changes is validated first (ADR-217). The
    amount and the cuota plan go through :meth:`ReceivableItem.revise`, which keeps an
    unchanged plan intact, re-derives a re-shaped schedule, and refuses to re-shape it while the
    item has allocations or pardons (ADR-216, ADR-224) — a check that stays true until commit
    because the person lock keeps payments out meanwhile. Identity, ``person_id`` and
    ``created_at`` are preserved.

    Args:
        command: The validated patch request, addressing one item by ``id``.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the updated item.

    Raises:
        PersonNotFoundError: When the person does not exist for the owner.
        ReceivableItemNotFoundError: When no item of that person matches ``command.id``.
        SourceTransactionNotFoundError: When a newly linked expense is missing, foreign or not
            an expense.
        InstallmentScheduleLockedError: When the plan would change shape while locked.
        InvalidInstallmentScheduleError: When the total cannot be split into the plan.
    """
    async with uow:
        await _locked_person(uow, command.person_id, command.user_id)
        existing = await _person_item(uow, command.id, command.person_id, command.user_id)
        link = _requested_link(existing, command)
        if link is not None and link != existing.source_transaction_id:
            await _check_source_expense(uow, link, command.user_id)
        allocations = await uow.receivables.allocated_amounts(existing.person_id)
        revised = existing.revise(
            amount=command.amount,
            plan=_requested_plan(existing, command),
            has_allocations=allocations.get(existing.id, NO_ALLOCATIONS).exist,
            created_at=datetime.now(UTC),
            new_id=uuid4,
        )
        patched = replace(
            revised,
            occurred_on=command.occurred_on if command.occurred_on is not None else existing.occurred_on,
            detail=command.detail if command.detail is not None else existing.detail,
            source_transaction_id=link,
        )
        await uow.receivables.persist_item(patched)
        await uow.commit()
    return patched.id


async def edit_receivable_installment(command: EditReceivableInstallment, uow: AbstractUnitOfWork) -> UUID:
    """Edit one cuota's amount and/or due date, re-deriving the item amount (ADR-216, ADR-130).

    Locks the person, loads the item scoped to the owner and that person (404 otherwise,
    ADR-111) and applies the edit through the aggregate, which keeps the cuota's identity — so
    allocations to it stay attached — re-derives the item amount as the sum of the cuotas, and
    refuses to lower the cuota below what was already paid toward it.

    Args:
        command: The validated cuota edit, addressing the cuota by item id and index.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the owning item.

    Raises:
        PersonNotFoundError: When the person does not exist for the owner.
        ReceivableItemNotFoundError: When no item of that person matches ``command.item_id``.
        ReceivableInstallmentNotFoundError: When the item has no cuota at ``command.index``.
        InvalidAmountError: When the new amount rounds to zero cents.
        InstallmentAmountBelowPaidError: When the new amount is below what was paid.
    """
    async with uow:
        await _locked_person(uow, command.person_id, command.user_id)
        existing = await _person_item(uow, command.item_id, command.person_id, command.user_id)
        allocations = await uow.receivables.allocated_amounts(existing.person_id)
        edited = existing.edit_installment(
            command.index,
            amount=command.amount,
            due_on=command.due_on,
            paid_by_installment=allocations.get(existing.id, NO_ALLOCATIONS).by_installment,
        )
        await uow.receivables.persist_item(edited)
        await uow.commit()
    return edited.id


async def set_receivable_installment_pardon(command: SetReceivableInstallmentPardon, uow: AbstractUnitOfWork) -> UUID:
    """Pardon or un-pardon a single cuota, reversibly (ADR-221, ADR-130).

    Locks the person and loads the item scoped to the owner and that person (404 otherwise).
    A pardoned cuota drops out of the person's outstanding and is no longer a valid allocation
    target, while staying on the schedule as "covered by you"; un-pardoning restores it. Never
    touches a balance (ADR-205).

    Args:
        command: The validated cuota pardon toggle.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the owning item.

    Raises:
        PersonNotFoundError: When the person does not exist for the owner.
        ReceivableItemNotFoundError: When no item of that person matches ``command.item_id``.
        ReceivableInstallmentNotFoundError: When the item has no cuota at ``command.index``.
    """
    async with uow:
        await _locked_person(uow, command.person_id, command.user_id)
        existing = await _person_item(uow, command.item_id, command.person_id, command.user_id)
        toggled = existing.set_installment_pardon(
            command.index,
            pardoned_at=datetime.now(UTC) if command.pardoned else None,
        )
        await uow.receivables.persist_item(toggled)
        await uow.commit()
    return toggled.id


async def set_receivable_item_pardon(command: SetReceivableItemPardon, uow: AbstractUnitOfWork) -> UUID:
    """Pardon or un-pardon one of the caller's items, reversibly (ADR-210, ADR-221, ADR-130).

    Locks the person and loads the item scoped to the owner and that person (a foreign or
    mismatched id is not found, ADR-111). A flat item has ``pardoned_at`` stamped with the
    moment of forgiveness when ``command.pardoned`` is set, or cleared back to ``None`` when it
    is not; on an installment item the whole remaining plan is the target instead — every cuota
    still owing is pardoned, or every pardoned cuota restored (ADR-221). Identity,
    ``person_id``, ``created_at`` and the other fields are preserved (ADR-026, ADR-031). A pardon
    drops the debt out of the person's outstanding and makes it no longer a valid allocation
    target (amending ADR-206), while staying persisted so it can be shown as "covered by you"
    (amending ADR-209). This never touches a balance (ADR-205). Toggling is idempotent —
    pardoning an already-pardoned flat item simply re-stamps the moment.

    Args:
        command: The validated pardon toggle, addressing one item by ``id``.
        uow: The unit of work providing the receivables repository.

    Returns:
        The UUID identity of the toggled item.

    Raises:
        PersonNotFoundError: When the person does not exist for the owner.
        ReceivableItemNotFoundError: When no item of that person matches ``command.id``.
    """
    async with uow:
        await _locked_person(uow, command.person_id, command.user_id)
        existing = await _person_item(uow, command.id, command.person_id, command.user_id)
        allocations = await uow.receivables.allocated_amounts(existing.person_id)
        toggled = existing.set_pardon(
            pardoned=command.pardoned,
            at=datetime.now(UTC),
            paid_by_installment=allocations.get(existing.id, NO_ALLOCATIONS).by_installment,
        )
        await uow.receivables.persist_item(toggled)
        await uow.commit()
    return toggled.id


async def delete_receivable_item(command: DeleteReceivableItem, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a receivable item by identity (ADR-204, ADR-208).

    Locks the person and checks the item is one of that person's, scoped to the owner, so a
    cross-tenant or mismatched delete removes nothing and the boundary answers 404 (ADR-111).
    The database cascades the item's cuotas and allocations away (ADR-208, ADR-214).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the receivables repository.

    Raises:
        PersonNotFoundError: When the person does not exist for the owner.
        ReceivableItemNotFoundError: When no item of that person matches ``command.id``.
    """
    async with uow:
        await _locked_person(uow, command.person_id, command.user_id)
        removed = await uow.receivables.delete_item(command.id, command.person_id)
        if not removed:
            raise ReceivableItemNotFoundError(command.id)
        await uow.commit()


async def record_receivable_payment(command: RecordReceivablePayment, uow: AbstractUnitOfWork) -> UUID:
    """Record an incoming payback and allocate it across items atomically (ADR-206, ADR-221, ADR-130).

    Enforces the settlement rules at the aggregate root's consistency boundary within one
    transaction, after locking the person so no concurrent write (a re-schedule, another
    payment) can change what is owed between these checks and the commit:

    1. The person must exist for the owner (else 404, ADR-111).
    2. On the confirm-match path only (``matched_income_transaction_id`` set, ADR-207), the
       linked income must exist, belong to this owner and be ``kind='income'`` (else 404,
       existence never leaked) AND must not already back another payment (else 409, the
       claimed invariant). Manual payments skip this and are unaffected.
    3. Every allocation must target one of that person's items (else 404) — a non-pardoned
       flat item as a whole, or one non-pardoned cuota of an installment item; naming no
       cuota on an installment item, or one on a flat item, is a ``422`` (ADR-221, ADR-223).
    4. The allocations may not sum to more than the payment's own ``amount`` — a true
       invariant violation (``422``).
    5. When the allocations exceed what the person owes as of ``command.as_of`` (only cuotas
       due by then count, ADR-215), an overpayment **warning** is raised unless
       ``allow_overpayment`` is set, so the API layer can confirm the credit rather than
       silently clamping or going negative. Paying a cuota ahead of its due date therefore
       goes through the same confirmation (ADR-224).
    6. Likewise, when the allocations to one item or cuota exceed what it still owes, a
       per-target **warning** is raised unless ``allow_overpayment`` is set — the excess would
       otherwise become a credit unnoticed whenever the person still owed enough elsewhere.

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
            the person's items, or a pardoned flat item.
        ReceivableInstallmentNotFoundError: When an allocation names a cuota that is not the
            item's or is pardoned.
        InstallmentAllocationTargetError: When the cuota targeting does not match the item.
        AllocationExceedsPaymentError: When the allocations sum to more than the payment.
        ReceivableOverpaymentError: When the allocations would overpay the person and
            ``allow_overpayment`` is not set (the confirm-warning path).
        AllocationExceedsTargetError: When the allocations would overpay one item or cuota and
            ``allow_overpayment`` is not set (the per-target confirm-warning path).
    """
    async with uow:
        person = await _locked_person(uow, command.person_id, command.user_id)
        if command.matched_income_transaction_id is not None:
            await _check_matched_income(uow, command.matched_income_transaction_id, command.user_id)

        items = {item.id: item for item in await uow.receivables.list_items(person.id)}
        requested = _requested_per_target(command, items)
        allocated_total = sum(requested.values(), _ZERO)
        if allocated_total > command.amount:
            raise AllocationExceedsPaymentError(command.amount, allocated_total)

        as_of = command.as_of if command.as_of is not None else datetime.now(UTC).date()
        allocations = await uow.receivables.allocated_amounts(person.id)
        positions = {
            item.id: assess_item(item, allocations.get(item.id, NO_ALLOCATIONS), as_of) for item in items.values()
        }
        if not command.allow_overpayment:
            _warn_on_overpayment(command, positions, requested, allocated_total)

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
                    installment_id=allocation.installment_id,
                )
            )
        await uow.commit()
    return payment.id


async def _locked_person(uow: AbstractUnitOfWork, person_id: UUID, user_id: str) -> Person:
    """Lock the owner's person — the aggregate root — before anything else is read (ADR-130).

    Every receivables write starts here, so writes on one person run one at a time and each
    handler's checks hold until it commits.

    Raises:
        PersonNotFoundError: When no person matches the id for the owner (404, ADR-111).
    """
    person = await uow.receivables.lock_person(person_id, user_id)
    if person is None:
        raise PersonNotFoundError(person_id)
    return person


async def _person_item(uow: AbstractUnitOfWork, item_id: UUID, person_id: UUID, user_id: str) -> ReceivableItem:
    """Load the owner's item, insisting it belongs to the addressed person (ADR-111, ADR-130).

    An item of another person — even one of the same owner — is treated as absent, so a URL
    pairing a person with someone else's item answers 404 instead of writing to it.

    Raises:
        ReceivableItemNotFoundError: When no item of that person matches the id for the owner.
    """
    item = await uow.receivables.get_item(item_id, user_id)
    if item is None or item.person_id != person_id:
        raise ReceivableItemNotFoundError(item_id)
    return item


async def _check_source_expense(uow: AbstractUnitOfWork, transaction_id: UUID, user_id: str) -> None:
    """Verify an item's expense link points at one of the caller's own expenses (ADR-217, ADR-130).

    Missing, foreign and non-expense transactions all collapse to one not-found so the
    boundary never leaks which case applies (ADR-111), mirroring the matched-income guard.

    Raises:
        SourceTransactionNotFoundError: When the transaction is not the owner's expense.
    """
    if not await uow.receivables.expense_exists_for_owner(transaction_id, user_id):
        raise SourceTransactionNotFoundError(transaction_id)


async def _check_matched_income(uow: AbstractUnitOfWork, income_id: UUID, user_id: str) -> None:
    """Validate a confirm-match's linked income inside the payment transaction (ADR-207).

    Runs before the payment is staged; manual payments (no matched id) never reach it.
    Mirrors the reimbursement offset-link guard.

    Raises:
        MatchedIncomeNotFoundError: When the income is missing, foreign or not ``kind='income'``
            — collapsed to one 404 so the boundary never leaks which case applies (ADR-111).
        IncomeAlreadyClaimedError: When the income already settles another payment (ADR-207).
    """
    if not await uow.receivables.income_exists_for_owner(income_id, user_id):
        raise MatchedIncomeNotFoundError(income_id)
    if await uow.receivables.income_is_claimed(income_id, user_id):
        raise IncomeAlreadyClaimedError(income_id)


def _requested_per_target(
    command: RecordReceivablePayment,
    items: dict[UUID, ReceivableItem],
) -> dict[tuple[UUID, UUID | None], Decimal]:
    """Check every allocation's target and total the payment per item/cuota target (ADR-206, ADR-221).

    Returns:
        The amount the payment allocates to each ``(item_id, installment_id)`` target, in the
        order the allocations name them.

    Raises:
        ReceivableItemNotFoundError: When an allocation targets an item that is not one of the
            person's, or a pardoned flat item.
        ReceivableInstallmentNotFoundError: When it names a cuota that is not the item's or is
            pardoned.
        InstallmentAllocationTargetError: When its cuota targeting does not match the item.
    """
    requested: dict[tuple[UUID, UUID | None], Decimal] = {}
    for allocation in command.allocations:
        item = items.get(allocation.item_id)
        if item is None:
            raise ReceivableItemNotFoundError(allocation.item_id)
        item.check_allocation_target(allocation.installment_id)
        target = (allocation.item_id, allocation.installment_id)
        requested[target] = requested.get(target, _ZERO) + allocation.amount
    return requested


def _warn_on_overpayment(
    command: RecordReceivablePayment,
    positions: dict[UUID, ItemPosition],
    requested: dict[tuple[UUID, UUID | None], Decimal],
    allocated_total: Decimal,
) -> None:
    """Raise the ADR-206 confirm-time warnings: person-level first, then per target.

    Raises:
        ReceivableOverpaymentError: When the payment allocates more than the person owes now.
        AllocationExceedsTargetError: When it allocates more to one item or cuota than it owes.
    """
    outstanding = person_outstanding(positions.values())
    if allocated_total > outstanding:
        raise ReceivableOverpaymentError(command.person_id, outstanding, allocated_total)
    overrun = find_target_overrun(positions, requested)
    if overrun is not None:
        raise AllocationExceedsTargetError(
            overrun.item_id,
            overrun.installment_id,
            overrun.remaining,
            overrun.requested,
        )


def _requested_plan(existing: ReceivableItem, command: EditReceivableItem) -> InstallmentPlan | None:
    """Resolve the cuota plan the patch asks for: removed, set, or the current one (ADR-216)."""
    if command.remove_installments:
        return None
    if command.installments is not None:
        return command.installments.to_plan()
    return existing.plan


def _requested_link(existing: ReceivableItem, command: EditReceivableItem) -> UUID | None:
    """Resolve the expense link the patch asks for: unlinked, set, or the current one (ADR-217)."""
    if command.unlink_source_transaction:
        return None
    if command.source_transaction_id is not None:
        return command.source_transaction_id
    return existing.source_transaction_id
