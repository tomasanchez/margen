"""Unit tests for the installment + expense-link receivable handlers (ADR-214..221).

Driven through the in-memory :class:`FakeUnitOfWork`, no database. They verify that items are
created with their cuota schedule and an optional, guarded expense link (same owner,
``kind='expense'``, ADR-217); that item edits keep, reshape, convert or refuse (lock) the plan
(ADR-216); that a cuota can be edited or pardoned on its own and an item-level pardon forgives
the whole remaining plan (ADR-221); and that payments target cuotas, with the overpayment
warning assessed on DUE cuotas only as of the command's date (ADR-215).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
    DeleteReceivableItem,
    EditReceivableInstallment,
    EditReceivableItem,
    InstallmentAdjustmentInput,
    InstallmentPlanInput,
    NewInstallmentPlanInput,
    RecordReceivablePayment,
    SetReceivableInstallmentPardon,
    SetReceivableItemPardon,
)
from margen_api.domain.messages import Command
from margen_api.domain.models.exceptions import (
    LOCKED_BY_ALLOCATIONS,
    AllocationExceedsTargetError,
    InstallmentAllocationTargetError,
    InstallmentAmountBelowPaidError,
    InstallmentScheduleLockedError,
    PersonNotFoundError,
    ReceivableInstallmentNotFoundError,
    ReceivableItemConflictError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
    SourceTransactionNotFoundError,
)
from margen_api.domain.models.receivable import (
    InstallmentPlan,
    ReceivableItem,
    build_person,
    build_receivable_allocation,
    build_receivable_item,
    build_receivable_payment,
)
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind, PaymentSource
from margen_api.service_layer.receivables import (
    add_receivable_item,
    delete_receivable_item,
    edit_receivable_installment,
    edit_receivable_item,
    record_receivable_payment,
    set_receivable_installment_pardon,
    set_receivable_item_pardon,
)
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"
A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_DATE = date(2026, 7, 1)
# A 3 x 1000 plan due Jul 10, Aug 10, Sep 10; payments are assessed as of Aug 10.
FIRST_DUE = date(2026, 7, 10)
AS_OF = date(2026, 8, 10)


def _seed_person(uow: FakeUnitOfWork, *, user_id: str = A_USER) -> UUID:
    """Place a committed person directly in the store and return its id."""
    person = build_person(person_id=uuid4(), name="Juan", user_id=user_id, created_at=A_TIME)
    uow.committed_people[person.id] = person
    return person.id


def _seed_plan_item(uow: FakeUnitOfWork, person_id: UUID, *, amount: str = "3000", count: int = 3) -> ReceivableItem:
    """Place a committed installment item directly in the store and return it."""
    item = build_receivable_item(
        item_id=uuid4(),
        person_id=person_id,
        occurred_on=A_DATE,
        amount=Decimal(amount),
        created_at=A_TIME,
        plan=InstallmentPlan(count=count, first_due_on=FIRST_DUE),
    )
    uow.committed_receivable_items[item.id] = item
    return item


def _seed_flat_item(uow: FakeUnitOfWork, person_id: UUID, *, amount: str = "1000") -> ReceivableItem:
    """Place a committed flat item directly in the store and return it."""
    item = build_receivable_item(
        item_id=uuid4(), person_id=person_id, occurred_on=A_DATE, amount=Decimal(amount), created_at=A_TIME
    )
    uow.committed_receivable_items[item.id] = item
    return item


def _seed_transaction(uow: FakeUnitOfWork, *, user_id: str = A_USER, kind: Kind = Kind.EXPENSE) -> UUID:
    """Place a committed transaction (an expense by default) and return its id."""
    transaction = build_transaction(
        occurred_on=A_DATE,
        name="Cena",
        kind=kind,
        amount=Decimal("9000"),
        user_id=user_id,
        transaction_id=uuid4(),
        created_at=A_TIME,
        updated_at=A_TIME,
    )
    uow.committed_aggregates[transaction.id] = transaction
    return transaction.id


def _seed_cuota_payment(uow: FakeUnitOfWork, item: ReceivableItem, index: int, amount: str) -> None:
    """Place a committed payment + allocation toward one cuota of ``item``."""
    payment = build_receivable_payment(
        payment_id=uuid4(), person_id=item.person_id, occurred_on=A_DATE, amount=Decimal(amount), created_at=A_TIME
    )
    uow.committed_receivable_payments[payment.id] = payment
    allocation = build_receivable_allocation(
        allocation_id=uuid4(),
        payment_id=payment.id,
        item_id=item.id,
        amount=Decimal(amount),
        installment_id=item.installment_at(index).id,
    )
    uow.committed_receivable_allocations[allocation.id] = allocation


def _payment(
    person_id: UUID,
    *allocations: AllocationInput,
    amount: str,
    as_of: date | None = AS_OF,
    allow_overpayment: bool = False,
) -> RecordReceivablePayment:
    """Build a manual payment command, assessed as of Aug 10 unless overridden."""
    return RecordReceivablePayment(
        user_id=A_USER,
        person_id=person_id,
        occurred_on=AS_OF,
        amount=Decimal(amount),
        allocations=allocations,
        as_of=as_of,
        allow_overpayment=allow_overpayment,
    )


class TestAddInstallmentItem:
    """Items are created flat or with their cuota schedule (ADR-214, ADR-216)."""

    async def test_creates_the_schedule_with_the_item(self):
        """
        GIVEN an owned person
        WHEN a 1000 item is added split into 3 cuotas from Jul 10
        THEN the committed item carries 333.33/333.33/333.34 due monthly and sums to 1000
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)

        # WHEN
        item_id = await add_receivable_item(
            AddReceivableItem(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("1000"),
                installments=NewInstallmentPlanInput(count=3, first_due_on=FIRST_DUE),
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item_id]
        assert [cuota.amount for cuota in stored.installments] == [
            Decimal("333.33"),
            Decimal("333.33"),
            Decimal("333.34"),
        ]
        assert [cuota.due_on for cuota in stored.installments] == [
            date(2026, 7, 10),
            date(2026, 8, 10),
            date(2026, 9, 10),
        ]
        assert stored.amount == Decimal("1000.00")
        assert len({cuota.id for cuota in stored.installments}) == 3

    async def test_links_one_of_the_owners_expenses(self):
        """
        GIVEN an owned person and one of the owner's expenses
        WHEN an item linking that expense is added
        THEN the item references it (reference only, ADR-217/219)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        expense_id = _seed_transaction(uow)

        # WHEN
        item_id = await add_receivable_item(
            AddReceivableItem(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("3000"),
                source_transaction_id=expense_id,
            ),
            uow,
        )

        # THEN
        assert uow.committed_receivable_items[item_id].source_transaction_id == expense_id

    @pytest.mark.parametrize("case", ["income", "foreign", "missing"])
    async def test_rejects_a_link_that_is_not_the_owners_expense(self, case: str):
        """
        GIVEN an income, another user's expense, or no transaction at all
        WHEN an item linking it is added
        THEN SourceTransactionNotFoundError is raised and nothing is committed (ADR-217, ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        target = {
            "income": lambda: _seed_transaction(uow, kind=Kind.INCOME),
            "foreign": lambda: _seed_transaction(uow, user_id=ANOTHER_USER),
            "missing": uuid4,
        }[case]()

        # WHEN / THEN
        with pytest.raises(SourceTransactionNotFoundError):
            await add_receivable_item(
                AddReceivableItem(
                    user_id=A_USER,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("1000"),
                    source_transaction_id=target,
                ),
                uow,
            )
        assert uow.committed_receivable_items == {}


class TestEditItemPlanAndLink:
    """Edits keep, reshape, convert or lock the plan, and guard the link (ADR-216, ADR-217)."""

    async def test_reshapes_an_unpaid_plan(self):
        """
        GIVEN an unpaid 3-cuota item
        WHEN the patch asks for 6 cuotas
        THEN the item is re-split into 6 x 500 with fresh cuotas
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(
                id=item.id,
                person_id=item.person_id,
                user_id=A_USER,
                installments=InstallmentPlanInput(count=6, first_due_on=FIRST_DUE),
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item.id]
        assert [cuota.amount for cuota in stored.installments] == [Decimal("500.00")] * 6
        assert stored.amount == Decimal("3000.00")

    async def test_refuses_to_reshape_a_plan_with_allocations(self):
        """
        GIVEN a 3-cuota item with a payment allocated to cuota 1
        WHEN the patch asks for 6 cuotas
        THEN InstallmentScheduleLockedError is raised and the stored plan is untouched (ADR-216)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))
        _seed_cuota_payment(uow, item, 1, "1000")

        # WHEN / THEN
        with pytest.raises(InstallmentScheduleLockedError) as excinfo:
            await edit_receivable_item(
                EditReceivableItem(
                    id=item.id,
                    person_id=item.person_id,
                    user_id=A_USER,
                    installments=InstallmentPlanInput(count=6, first_due_on=FIRST_DUE),
                ),
                uow,
            )
        assert excinfo.value.reason == LOCKED_BY_ALLOCATIONS
        assert uow.committed_receivable_items[item.id] is item

    async def test_resending_the_current_plan_keeps_cuota_edits_even_when_paid(self):
        """
        GIVEN a paid-into 3-cuota item whose cuota 3 carries interest
        WHEN the patch re-sends the same plan and a new detail
        THEN the detail changes and the cuotas (with the interest) are kept
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow)).edit_installment(
            3, amount=Decimal("1200"), paid_by_installment={}
        )
        uow.committed_receivable_items[item.id] = item
        _seed_cuota_payment(uow, item, 1, "1000")

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(
                id=item.id,
                person_id=item.person_id,
                user_id=A_USER,
                detail="cena",
                installments=InstallmentPlanInput(count=3, first_due_on=FIRST_DUE),
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item.id]
        assert stored.detail == "cena"
        assert stored.installments == item.installments
        assert stored.amount == Decimal("3200.00")

    async def test_removes_the_plan_and_patches_date(self):
        """
        GIVEN an unpaid 3-cuota item
        WHEN the patch removes the plan and moves the date
        THEN the item is flat again, same total, new date
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(
                id=item.id,
                person_id=item.person_id,
                user_id=A_USER,
                remove_installments=True,
                occurred_on=date(2026, 6, 30),
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item.id]
        assert stored.installments == ()
        assert stored.amount == Decimal("3000.00")
        assert stored.occurred_on == date(2026, 6, 30)

    async def test_links_then_unlinks_an_expense(self):
        """
        GIVEN a flat item and one of the owner's expenses
        WHEN the patch links the expense, then a later patch unlinks it
        THEN the reference is set, then cleared
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_flat_item(uow, _seed_person(uow))
        expense_id = _seed_transaction(uow)

        # WHEN — link.
        await edit_receivable_item(
            EditReceivableItem(id=item.id, person_id=item.person_id, user_id=A_USER, source_transaction_id=expense_id),
            uow,
        )
        linked = uow.committed_receivable_items[item.id].source_transaction_id

        # AND — unlink.
        await edit_receivable_item(
            EditReceivableItem(id=item.id, person_id=item.person_id, user_id=A_USER, unlink_source_transaction=True),
            uow,
        )

        # THEN
        assert linked == expense_id
        assert uow.committed_receivable_items[item.id].source_transaction_id is None

    async def test_keeping_an_existing_link_does_not_revalidate_it(self):
        """
        GIVEN an item whose linked expense no longer exists (the reference dangles)
        WHEN an unrelated field is patched
        THEN the edit succeeds and the reference is preserved (only a NEW link is validated)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_flat_item(uow, _seed_person(uow))
        dangling = uuid4()
        item.source_transaction_id = dangling

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(id=item.id, person_id=item.person_id, user_id=A_USER, detail="x"), uow
        )

        # THEN
        assert uow.committed_receivable_items[item.id].source_transaction_id == dangling

    async def test_rejects_a_new_link_to_an_income(self):
        """
        GIVEN a flat item and an income transaction
        WHEN the patch links the income
        THEN SourceTransactionNotFoundError is raised (ADR-217)
        """
        uow = FakeUnitOfWork()
        item = _seed_flat_item(uow, _seed_person(uow))
        income_id = _seed_transaction(uow, kind=Kind.INCOME)
        with pytest.raises(SourceTransactionNotFoundError):
            await edit_receivable_item(
                EditReceivableItem(
                    id=item.id, person_id=item.person_id, user_id=A_USER, source_transaction_id=income_id
                ),
                uow,
            )


class TestEditInstallment:
    """A single cuota's amount/date can be edited, re-deriving the item amount (ADR-216)."""

    async def test_edits_a_cuota_after_payments(self):
        """
        GIVEN a 3-cuota item with cuota 1 paid
        WHEN cuota 2 gets a recargo (1100) and a new due date
        THEN the cuota changes in place and the item amount becomes 3100
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))
        _seed_cuota_payment(uow, item, 1, "1000")

        # WHEN
        await edit_receivable_installment(
            EditReceivableInstallment(
                item_id=item.id,
                person_id=item.person_id,
                user_id=A_USER,
                index=2,
                amount=Decimal("1100"),
                due_on=date(2026, 8, 20),
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item.id]
        assert stored.amount == Decimal("3100.00")
        assert stored.installments[1].amount == Decimal("1100.00")
        assert stored.installments[1].due_on == date(2026, 8, 20)
        assert stored.installments[1].id == item.installments[1].id

    async def test_missing_or_foreign_item_is_not_found(self):
        """
        GIVEN an item owned by user A
        WHEN user B edits its cuota
        THEN the person lock misses first: PersonNotFoundError, a 404 (ADR-111)
        """
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))
        with pytest.raises(PersonNotFoundError):
            await edit_receivable_installment(
                EditReceivableInstallment(
                    item_id=item.id, person_id=item.person_id, user_id=ANOTHER_USER, index=1, amount=Decimal("1")
                ),
                uow,
            )

    async def test_unknown_index_is_not_found(self):
        """
        GIVEN a 3-cuota item
        WHEN cuota 7 is edited
        THEN ReceivableInstallmentNotFoundError is raised
        """
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))
        with pytest.raises(ReceivableInstallmentNotFoundError):
            await edit_receivable_installment(
                EditReceivableInstallment(
                    item_id=item.id, person_id=item.person_id, user_id=A_USER, index=7, amount=Decimal("1")
                ),
                uow,
            )


class TestInstallmentPardons:
    """Pardon a single cuota, or the whole remaining plan through the item (ADR-221)."""

    async def test_pardons_and_restores_one_cuota(self):
        """
        GIVEN a 3-cuota item
        WHEN cuota 2 is pardoned, then un-pardoned
        THEN only cuota 2 was stamped, and is cleared again
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))

        # WHEN
        await set_receivable_installment_pardon(
            SetReceivableInstallmentPardon(
                item_id=item.id, person_id=item.person_id, user_id=A_USER, index=2, pardoned=True
            ),
            uow,
        )
        pardoned = [cuota.pardoned for cuota in uow.committed_receivable_items[item.id].installments]
        await set_receivable_installment_pardon(
            SetReceivableInstallmentPardon(
                item_id=item.id, person_id=item.person_id, user_id=A_USER, index=2, pardoned=False
            ),
            uow,
        )

        # THEN
        assert pardoned == [False, True, False]
        assert not any(cuota.pardoned for cuota in uow.committed_receivable_items[item.id].installments)

    async def test_cuota_pardon_of_missing_item_is_not_found(self):
        """
        GIVEN an owned person but no item with the requested id
        WHEN one of its cuotas is pardoned
        THEN ReceivableItemNotFoundError is raised
        """
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        with pytest.raises(ReceivableItemNotFoundError):
            await set_receivable_installment_pardon(
                SetReceivableInstallmentPardon(
                    item_id=uuid4(), person_id=person_id, user_id=A_USER, index=1, pardoned=True
                ),
                uow,
            )

    async def test_item_pardon_forgives_the_remaining_plan(self):
        """
        GIVEN a 3-cuota item with cuota 1 fully paid
        WHEN the item is pardoned, then un-pardoned
        THEN cuotas 2 and 3 are forgiven (cuota 1 stays paid, no item-level stamp), and the
             un-pardon restores them
        """
        # GIVEN
        uow = FakeUnitOfWork()
        item = _seed_plan_item(uow, _seed_person(uow))
        _seed_cuota_payment(uow, item, 1, "1000")

        # WHEN
        await set_receivable_item_pardon(
            SetReceivableItemPardon(id=item.id, person_id=item.person_id, user_id=A_USER, pardoned=True), uow
        )
        forgiven = uow.committed_receivable_items[item.id]
        await set_receivable_item_pardon(
            SetReceivableItemPardon(id=item.id, person_id=item.person_id, user_id=A_USER, pardoned=False), uow
        )

        # THEN
        assert [cuota.pardoned for cuota in forgiven.installments] == [False, True, True]
        assert forgiven.pardoned_at is None
        assert not any(cuota.pardoned for cuota in uow.committed_receivable_items[item.id].installments)


class TestCuotaPayments:
    """Payments target cuotas; the overpayment guard counts due cuotas only (ADR-215, ADR-221)."""

    async def test_allocation_to_a_due_cuota_is_recorded_with_its_cuota(self):
        """
        GIVEN a 3 x 1000 plan (2 cuotas due as of Aug 10)
        WHEN 1000 is allocated to cuota 1
        THEN the committed allocation names cuota 1
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        first = item.installment_at(1)

        # WHEN
        await record_receivable_payment(
            _payment(
                person_id,
                AllocationInput(item_id=item.id, installment_id=first.id, amount=Decimal("1000")),
                amount="1000",
            ),
            uow,
        )

        # THEN
        (allocation,) = uow.committed_receivable_allocations.values()
        assert allocation.installment_id == first.id
        assert allocation.item_id == item.id

    async def test_paying_ahead_of_the_due_cuotas_warns(self):
        """
        GIVEN a 3 x 1000 plan with 2000 due as of Aug 10
        WHEN 3000 is allocated across all three cuotas (one not yet due)
        THEN the overpayment warning fires against the DUE 2000 only (ADR-215)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        allocations = tuple(
            AllocationInput(item_id=item.id, installment_id=cuota.id, amount=Decimal("1000"))
            for cuota in item.installments
        )

        # WHEN / THEN
        with pytest.raises(ReceivableOverpaymentError) as excinfo:
            await record_receivable_payment(_payment(person_id, *allocations, amount="3000"), uow)
        assert excinfo.value.outstanding == Decimal("2000.00")
        assert excinfo.value.requested == Decimal("3000")

    async def test_early_payoff_is_recorded_once_confirmed(self):
        """
        GIVEN the same plan
        WHEN the early payoff is confirmed with allow_overpayment
        THEN all three cuota allocations are committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        allocations = tuple(
            AllocationInput(item_id=item.id, installment_id=cuota.id, amount=Decimal("1000"))
            for cuota in item.installments
        )

        # WHEN
        await record_receivable_payment(_payment(person_id, *allocations, amount="3000", allow_overpayment=True), uow)

        # THEN
        assert len(uow.committed_receivable_allocations) == 3

    async def test_defaults_the_assessment_to_the_current_date(self):
        """
        GIVEN a plan whose cuotas all fell due in 2020
        WHEN a payment for the whole plan carries no as_of
        THEN today's date is used, every cuota is due, and no warning fires
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = build_receivable_item(
            item_id=uuid4(),
            person_id=person_id,
            occurred_on=date(2020, 1, 1),
            amount=Decimal("2000"),
            created_at=A_TIME,
            plan=InstallmentPlan(count=2, first_due_on=date(2020, 2, 1)),
        )
        uow.committed_receivable_items[item.id] = item
        allocations = tuple(
            AllocationInput(item_id=item.id, installment_id=cuota.id, amount=Decimal("1000"))
            for cuota in item.installments
        )

        # WHEN
        await record_receivable_payment(_payment(person_id, *allocations, amount="2000", as_of=None), uow)

        # THEN
        assert len(uow.committed_receivable_allocations) == 2

    @pytest.mark.parametrize("target", ["plan-without-cuota", "flat-with-cuota"])
    async def test_cuota_targeting_must_match_the_item(self, target: str):
        """
        GIVEN an installment item and a flat item
        WHEN a payment allocates to the installment item without a cuota, or to the flat item
             with one
        THEN InstallmentAllocationTargetError is raised and nothing is committed (ADR-223)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        plan_item = _seed_plan_item(uow, person_id)
        flat_item = _seed_flat_item(uow, person_id)
        allocation = (
            AllocationInput(item_id=plan_item.id, amount=Decimal("100"))
            if target == "plan-without-cuota"
            else AllocationInput(item_id=flat_item.id, installment_id=uuid4(), amount=Decimal("100"))
        )

        # WHEN / THEN
        with pytest.raises(InstallmentAllocationTargetError):
            await record_receivable_payment(_payment(person_id, allocation, amount="100"), uow)
        assert uow.committed_receivable_payments == {}

    async def test_pardoned_cuota_is_not_payable(self):
        """
        GIVEN a plan whose cuota 1 is pardoned
        WHEN a payment allocates to cuota 1
        THEN ReceivableInstallmentNotFoundError is raised (a forgiven cuota is not payable)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id).set_installment_pardon(1, pardoned_at=A_TIME)
        uow.committed_receivable_items[item.id] = item

        # WHEN / THEN
        with pytest.raises(ReceivableInstallmentNotFoundError):
            await record_receivable_payment(
                _payment(
                    person_id,
                    AllocationInput(item_id=item.id, installment_id=item.installment_at(1).id, amount=Decimal("100")),
                    amount="100",
                ),
                uow,
            )


def _write_commands(uow: FakeUnitOfWork) -> dict[str, tuple[Callable[..., Awaitable[object]], Command]]:
    """Seed a person with an installment item and an income, and build one command per write handler."""
    person_id = _seed_person(uow)
    item = _seed_plan_item(uow, person_id)
    income_id = _seed_transaction(uow, kind=Kind.INCOME)
    first = item.installment_at(1).id
    cuota_payment = AllocationInput(item_id=item.id, installment_id=first, amount=Decimal("100"))
    return {
        "add-item": (
            add_receivable_item,
            AddReceivableItem(user_id=A_USER, person_id=person_id, occurred_on=A_DATE, amount=Decimal("100")),
        ),
        "edit-item": (
            edit_receivable_item,
            EditReceivableItem(id=item.id, person_id=person_id, user_id=A_USER, detail="x"),
        ),
        "delete-item": (
            delete_receivable_item,
            DeleteReceivableItem(id=item.id, person_id=person_id, user_id=A_USER),
        ),
        "pardon-item": (
            set_receivable_item_pardon,
            SetReceivableItemPardon(id=item.id, person_id=person_id, user_id=A_USER, pardoned=True),
        ),
        "unpardon-item": (
            set_receivable_item_pardon,
            SetReceivableItemPardon(id=item.id, person_id=person_id, user_id=A_USER, pardoned=False),
        ),
        "edit-cuota": (
            edit_receivable_installment,
            EditReceivableInstallment(
                item_id=item.id, person_id=person_id, user_id=A_USER, index=1, amount=Decimal("900")
            ),
        ),
        "pardon-cuota": (
            set_receivable_installment_pardon,
            SetReceivableInstallmentPardon(
                item_id=item.id, person_id=person_id, user_id=A_USER, index=1, pardoned=True
            ),
        ),
        "unpardon-cuota": (
            set_receivable_installment_pardon,
            SetReceivableInstallmentPardon(
                item_id=item.id, person_id=person_id, user_id=A_USER, index=1, pardoned=False
            ),
        ),
        "record-payment": (record_receivable_payment, _payment(person_id, cuota_payment, amount="100")),
        "confirm-match": (
            record_receivable_payment,
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=AS_OF,
                amount=Decimal("100"),
                allocations=(cuota_payment,),
                source=PaymentSource.MATCHED_INCOME,
                matched_income_transaction_id=income_id,
                as_of=AS_OF,
            ),
        ),
    }


_WRITES = (
    "add-item",
    "edit-item",
    "delete-item",
    "pardon-item",
    "unpardon-item",
    "edit-cuota",
    "pardon-cuota",
    "unpardon-cuota",
    "record-payment",
    "confirm-match",
)


class TestPersonLock:
    """Every receivables write locks the person — the aggregate root — first (concurrency, ADR-130)."""

    @pytest.mark.parametrize("write", _WRITES)
    async def test_the_person_is_locked_before_anything_is_read(self, write: str):
        """
        GIVEN a person with an installment item
        WHEN any receivables write handler runs
        THEN its very first repository call is lock_person, so its checks and writes are
             serialized with every other write on that person
        """
        # GIVEN
        uow = FakeUnitOfWork()
        handler, command = _write_commands(uow)[write]

        # WHEN
        await handler(command, uow)

        # THEN
        assert uow.receivable_calls[0] == "lock_person"
        assert uow.receivable_calls.count("lock_person") == 1


class TestItemsAreScopedToTheAddressedPerson:
    """An item addressed through another person is not found, never written (ADR-111)."""

    @pytest.mark.parametrize("write", ["edit-item", "delete-item", "pardon-item", "edit-cuota", "pardon-cuota"])
    async def test_another_persons_item_is_not_found(self, write: str):
        """
        GIVEN two people of the same owner, the item belonging to the first
        WHEN a write addresses that item through the second person
        THEN ReceivableItemNotFoundError is raised and the item is untouched
        """
        # GIVEN
        uow = FakeUnitOfWork()
        handler, command = _write_commands(uow)[write]
        other_person = _seed_person(uow)
        item_id = next(iter(uow.committed_receivable_items))
        before = uow.committed_receivable_items[item_id]

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await handler(command.model_copy(update={"person_id": other_person}), uow)
        assert uow.committed_receivable_items[item_id] is before


class TestIdempotentCreate:
    """A client-chosen item id makes a retried creation safe (ADR-204)."""

    def _command(self, person_id: UUID, item_id: UUID, amount: str = "1000") -> AddReceivableItem:
        return AddReceivableItem(
            user_id=A_USER,
            person_id=person_id,
            occurred_on=A_DATE,
            amount=Decimal(amount),
            installments=NewInstallmentPlanInput(
                count=2,
                first_due_on=FIRST_DUE,
                cuotas=(InstallmentAdjustmentInput(index=2, amount=Decimal("700")),),
            ),
            item_id=item_id,
        )

    async def test_same_id_and_terms_replays_without_a_duplicate(self):
        """
        GIVEN an item created with a client id (500 + a cuota tweaked to 700)
        WHEN the very same request is retried
        THEN the same id comes back, nothing new is staged and there is still one item
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = uuid4()
        created = await add_receivable_item(self._command(person_id, item_id), uow)
        uow.receivable_calls.clear()

        # WHEN
        replayed = await add_receivable_item(self._command(person_id, item_id), uow)

        # THEN
        assert created == replayed == item_id
        assert "add_item" not in uow.receivable_calls
        assert list(uow.committed_receivable_items) == [item_id]
        assert [cuota.amount for cuota in uow.committed_receivable_items[item_id].installments] == [
            Decimal("500.00"),
            Decimal("700.00"),
        ]

    async def test_same_id_with_other_terms_is_a_conflict(self):
        """
        GIVEN an item created with a client id
        WHEN the id is reused with a different amount
        THEN ReceivableItemConflictError is raised and the stored item is unchanged
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = uuid4()
        await add_receivable_item(self._command(person_id, item_id), uow)
        stored = uow.committed_receivable_items[item_id]

        # WHEN / THEN
        with pytest.raises(ReceivableItemConflictError):
            await add_receivable_item(self._command(person_id, item_id, amount="2000"), uow)
        assert uow.committed_receivable_items[item_id] is stored

    async def test_an_id_taken_by_another_owner_is_a_conflict(self):
        """
        GIVEN another owner's item using some id
        WHEN the caller creates an item with that id
        THEN ReceivableItemConflictError is raised (never a duplicate key, never a leak)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        foreign = _seed_plan_item(uow, _seed_person(uow, user_id=ANOTHER_USER))
        person_id = _seed_person(uow)

        # WHEN / THEN
        with pytest.raises(ReceivableItemConflictError):
            await add_receivable_item(self._command(person_id, foreign.id), uow)


class TestPerTargetOverpayment:
    """Paying one item or cuota beyond what it owes needs confirmation (ADR-206, ADR-221)."""

    async def test_overrunning_a_cuota_warns_even_when_the_person_owes_enough(self):
        """
        GIVEN the 3 x 1000 plan with 2000 due
        WHEN 1200 is allocated to cuota 1 (in two slices) without confirmation
        THEN AllocationExceedsTargetError reports cuota 1's 1000 remaining against 1200 requested
             and nothing is recorded
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        first = item.installment_at(1).id
        slices = (
            AllocationInput(item_id=item.id, installment_id=first, amount=Decimal("700")),
            AllocationInput(item_id=item.id, installment_id=first, amount=Decimal("500")),
        )

        # WHEN / THEN
        with pytest.raises(AllocationExceedsTargetError) as excinfo:
            await record_receivable_payment(_payment(person_id, *slices, amount="1200"), uow)
        assert (excinfo.value.item_id, excinfo.value.installment_id) == (item.id, first)
        assert (excinfo.value.remaining, excinfo.value.requested) == (Decimal("1000.00"), Decimal("1200"))
        assert uow.committed_receivable_payments == {}

    async def test_overrunning_a_flat_item_warns(self):
        """
        GIVEN a flat 1000 item next to the plan (3000 owed in total)
        WHEN 1500 is allocated to the flat item
        THEN AllocationExceedsTargetError reports the flat item (no cuota)
        """
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        _seed_plan_item(uow, person_id)
        flat = _seed_flat_item(uow, person_id)
        with pytest.raises(AllocationExceedsTargetError) as excinfo:
            await record_receivable_payment(
                _payment(person_id, AllocationInput(item_id=flat.id, amount=Decimal("1500")), amount="1500"), uow
            )
        assert excinfo.value.installment_id is None

    async def test_a_confirmed_overrun_is_recorded_as_a_credit(self):
        """
        GIVEN the same over-allocation to cuota 1
        WHEN it is confirmed with allow_overpayment
        THEN the payment is recorded
        """
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        allocation = AllocationInput(item_id=item.id, installment_id=item.installment_at(1).id, amount=Decimal("1200"))
        await record_receivable_payment(_payment(person_id, allocation, amount="1200", allow_overpayment=True), uow)
        assert len(uow.committed_receivable_allocations) == 1


class TestCuotaFloorThroughTheHandler:
    """The cuota edit handler feeds what was paid into the floor check (ADR-216)."""

    async def test_lowering_a_paid_cuota_below_its_payment_is_rejected(self):
        """
        GIVEN cuota 1 fully paid (1000)
        WHEN it is edited down to 500
        THEN InstallmentAmountBelowPaidError is raised and the item is unchanged
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item = _seed_plan_item(uow, person_id)
        _seed_cuota_payment(uow, item, 1, "1000")

        # WHEN / THEN
        with pytest.raises(InstallmentAmountBelowPaidError):
            await edit_receivable_installment(
                EditReceivableInstallment(
                    item_id=item.id, person_id=person_id, user_id=A_USER, index=1, amount=Decimal("500")
                ),
                uow,
            )
        assert uow.committed_receivable_items[item.id] is item
