"""Unit tests for the receivables application handlers (ADR-204, ADR-206, ADR-130).

Driven through the in-memory :class:`FakeUnitOfWork` so they run with no database. They
verify the person/item CRUD handlers inject identity/timestamps, preserve ownership and
``created_at``, and raise the not-found errors for missing/cross-tenant ids (ADR-111); that
deleting a person or item cascades its subtree the way the DB FKs do (ADR-208); and the
record-payment settlement rules of ADR-206 — partial and multi-item allocations, the
allocation-exceeds-payment invariant (422), and the overpayment WARNING that fires unless
the caller confirms with ``allow_overpayment`` (never a silent clamp, never silent
negative).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
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
    build_person,
    build_receivable_allocation,
    build_receivable_item,
    build_receivable_payment,
)
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind, PaymentSource
from margen_api.service_layer.receivables import (
    add_receivable_item,
    create_person,
    delete_person,
    delete_receivable_item,
    edit_receivable_item,
    record_receivable_payment,
    rename_person,
)
from tests.fakes.persistence import FakeUnitOfWork

A_USER = "00000000-0000-4000-8000-000000000001"
ANOTHER_USER = "00000000-0000-4000-8000-000000000002"
A_DATE = date(2026, 8, 1)
A_TIME = datetime(2026, 1, 1, tzinfo=UTC)


def _seed_person(uow: FakeUnitOfWork, *, user_id: str = A_USER, name: str = "Juan") -> UUID:
    """Place a committed person directly in the store and return its id."""
    person = build_person(person_id=uuid4(), name=name, user_id=user_id, created_at=A_TIME)
    uow.committed_people[person.id] = person
    return person.id


def _seed_item(
    uow: FakeUnitOfWork,
    *,
    person_id: UUID,
    amount: str,
    occurred_on: date = A_DATE,
    detail: str | None = None,
) -> UUID:
    """Place a committed receivable item directly in the store and return its id."""
    item = build_receivable_item(
        item_id=uuid4(),
        person_id=person_id,
        occurred_on=occurred_on,
        amount=Decimal(amount),
        detail=detail,
        created_at=A_TIME,
    )
    uow.committed_receivable_items[item.id] = item
    return item.id


def _seed_income(uow: FakeUnitOfWork, *, user_id: str = A_USER, name: str = "Juan", kind: Kind = Kind.INCOME) -> UUID:
    """Place a committed transaction (income by default) in the store and return its id."""
    income = build_transaction(
        occurred_on=A_DATE,
        name=name,
        kind=kind,
        amount=Decimal("1000"),
        user_id=user_id,
        transaction_id=uuid4(),
        created_at=A_TIME,
        updated_at=A_TIME,
    )
    uow.committed_aggregates[income.id] = income
    return income.id


def _seed_claimed_payment(uow: FakeUnitOfWork, *, person_id: UUID, income_id: UUID) -> None:
    """Place a committed matched-income payment linking ``income_id`` (already claimed)."""
    payment = build_receivable_payment(
        payment_id=uuid4(),
        person_id=person_id,
        occurred_on=A_DATE,
        amount=Decimal("1000"),
        source=PaymentSource.MATCHED_INCOME,
        matched_income_transaction_id=income_id,
        created_at=A_TIME,
    )
    uow.committed_receivable_payments[payment.id] = payment


def _seed_allocation(uow: FakeUnitOfWork, *, person_id: UUID, item_id: UUID, amount: str) -> None:
    """Place a committed payment + allocation so an item already has money against it."""
    payment = build_receivable_payment(
        payment_id=uuid4(),
        person_id=person_id,
        occurred_on=A_DATE,
        amount=Decimal(amount),
        created_at=A_TIME,
    )
    uow.committed_receivable_payments[payment.id] = payment
    allocation = build_receivable_allocation(
        allocation_id=uuid4(),
        payment_id=payment.id,
        item_id=item_id,
        amount=Decimal(amount),
    )
    uow.committed_receivable_allocations[allocation.id] = allocation


class TestCreatePerson:
    """The create handler persists a new owned person (ADR-204, ADR-130)."""

    async def test_persists_and_commits(self):
        """
        GIVEN a valid create command
        WHEN the create handler runs
        THEN the person is committed, owned by the caller, and its id returned
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN
        person_id = await create_person(CreatePerson(user_id=A_USER, name="  Juan  "), uow)

        # THEN
        assert uow.committed is True
        stored = uow.committed_people[person_id]
        assert stored.user_id == A_USER
        assert stored.name == "Juan"  # trimmed by the domain invariant


class TestRenamePerson:
    """The rename handler patches the name while preserving identity/ownership (ADR-204)."""

    async def test_renames_and_preserves_created_at_and_owner(self):
        """
        GIVEN an existing owned person
        WHEN the rename handler runs
        THEN the name changes while created_at and ownership are preserved
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, name="Old")

        # WHEN
        await rename_person(RenamePerson(id=person_id, user_id=A_USER, name="New"), uow)

        # THEN
        renamed = uow.committed_people[person_id]
        assert renamed.name == "New"
        assert renamed.created_at == A_TIME
        assert renamed.user_id == A_USER

    async def test_missing_person_raises_not_found(self):
        """
        GIVEN no person with the requested id
        WHEN the rename handler runs
        THEN PersonNotFoundError is raised (mapped to 404)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await rename_person(RenamePerson(id=uuid4(), user_id=A_USER, name="New"), uow)

    async def test_cross_tenant_rename_is_not_found(self):
        """
        GIVEN a person owned by user A
        WHEN user B renames it
        THEN PersonNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await rename_person(RenamePerson(id=person_id, user_id=ANOTHER_USER, name="New"), uow)


class TestDeletePerson:
    """The delete handler is an owner-scoped hard delete that cascades (ADR-204, ADR-208)."""

    async def test_deletes_owned_person_and_cascades_subtree(self):
        """
        GIVEN a person with an item, a payment and an allocation
        WHEN the delete handler runs
        THEN the person and their entire subtree are removed and the delete is committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        _seed_allocation(uow, person_id=person_id, item_id=item_id, amount="400")

        # WHEN
        await delete_person(DeletePerson(id=person_id, user_id=A_USER), uow)

        # THEN — nothing of the person's subtree survives (ADR-208).
        assert person_id not in uow.committed_people
        assert uow.committed_receivable_items == {}
        assert uow.committed_receivable_payments == {}
        assert uow.committed_receivable_allocations == {}
        assert uow.committed is True

    async def test_missing_person_raises_not_found(self):
        """
        GIVEN no person with the requested id
        WHEN the delete handler runs
        THEN PersonNotFoundError is raised (mapped to 404)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await delete_person(DeletePerson(id=uuid4(), user_id=A_USER), uow)

    async def test_cross_tenant_delete_is_not_found(self):
        """
        GIVEN a person owned by user A
        WHEN user B deletes it
        THEN PersonNotFoundError is raised and A's person survives (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await delete_person(DeletePerson(id=person_id, user_id=ANOTHER_USER), uow)
        assert person_id in uow.committed_people


class TestAddReceivableItem:
    """The add-item handler attaches an itemized debt to an owned person (ADR-204)."""

    async def test_adds_item_to_owned_person(self):
        """
        GIVEN an existing owned person
        WHEN the add-item handler runs
        THEN the item is committed under the person with a normalized blank detail
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
                amount=Decimal("1500"),
                detail="   ",
            ),
            uow,
        )

        # THEN
        stored = uow.committed_receivable_items[item_id]
        assert stored.person_id == person_id
        assert stored.amount == Decimal("1500")
        assert stored.detail is None  # blank trimmed to absent by the domain

    async def test_missing_person_raises_not_found(self):
        """
        GIVEN no person with the requested id
        WHEN the add-item handler runs
        THEN PersonNotFoundError is raised and no item is created (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await add_receivable_item(
                AddReceivableItem(user_id=A_USER, person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("1")),
                uow,
            )
        assert uow.committed_receivable_items == {}

    async def test_cross_tenant_person_raises_not_found(self):
        """
        GIVEN a person owned by user A
        WHEN user B adds an item to it
        THEN PersonNotFoundError is raised — existence is never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await add_receivable_item(
                AddReceivableItem(user_id=ANOTHER_USER, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1")),
                uow,
            )


class TestEditReceivableItem:
    """The edit-item handler applies a partial patch and re-runs invariants (ADR-204)."""

    async def test_patches_present_fields_and_preserves_person_and_created_at(self):
        """
        GIVEN an existing owned item
        WHEN the edit handler patches only the amount
        THEN the amount changes and person_id/created_at/other fields are preserved
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000", detail="lunch")

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(id=item_id, user_id=A_USER, amount=Decimal("800")),
            uow,
        )

        # THEN
        patched = uow.committed_receivable_items[item_id]
        assert patched.amount == Decimal("800")
        assert patched.detail == "lunch"  # left unchanged
        assert patched.occurred_on == A_DATE
        assert patched.person_id == person_id
        assert patched.created_at == A_TIME

    async def test_patches_date_and_detail(self):
        """
        GIVEN an existing owned item
        WHEN the edit handler patches the date and detail
        THEN both change while the amount is left unchanged
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN
        await edit_receivable_item(
            EditReceivableItem(
                id=item_id,
                user_id=A_USER,
                occurred_on=date(2026, 9, 9),
                detail="dinner",
            ),
            uow,
        )

        # THEN
        patched = uow.committed_receivable_items[item_id]
        assert patched.occurred_on == date(2026, 9, 9)
        assert patched.detail == "dinner"
        assert patched.amount == Decimal("1000")

    async def test_missing_item_raises_not_found(self):
        """
        GIVEN no item with the requested id
        WHEN the edit handler runs
        THEN ReceivableItemNotFoundError is raised (mapped to 404)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await edit_receivable_item(EditReceivableItem(id=uuid4(), user_id=A_USER, amount=Decimal("1")), uow)

    async def test_cross_tenant_edit_is_not_found(self):
        """
        GIVEN an item under a person owned by user A
        WHEN user B edits it
        THEN ReceivableItemNotFoundError is raised (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await edit_receivable_item(EditReceivableItem(id=item_id, user_id=ANOTHER_USER, amount=Decimal("1")), uow)


class TestDeleteReceivableItem:
    """The delete-item handler is an owner-scoped hard delete that cascades (ADR-208)."""

    async def test_deletes_owned_item_and_cascades_allocations(self):
        """
        GIVEN an item that has a payment allocated against it
        WHEN the delete handler runs
        THEN the item and its allocation are removed while the payment survives
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        _seed_allocation(uow, person_id=person_id, item_id=item_id, amount="400")

        # WHEN
        await delete_receivable_item(DeleteReceivableItem(id=item_id, user_id=A_USER), uow)

        # THEN
        assert item_id not in uow.committed_receivable_items
        assert uow.committed_receivable_allocations == {}
        assert uow.committed_receivable_payments != {}  # the payment itself is untouched
        assert uow.committed is True

    async def test_missing_item_raises_not_found(self):
        """
        GIVEN no item with the requested id
        WHEN the delete handler runs
        THEN ReceivableItemNotFoundError is raised (mapped to 404)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await delete_receivable_item(DeleteReceivableItem(id=uuid4(), user_id=A_USER), uow)

    async def test_cross_tenant_delete_is_not_found(self):
        """
        GIVEN an item under a person owned by user A
        WHEN user B deletes it
        THEN ReceivableItemNotFoundError is raised and the item survives (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await delete_receivable_item(DeleteReceivableItem(id=item_id, user_id=ANOTHER_USER), uow)
        assert item_id in uow.committed_receivable_items


class TestRecordReceivablePayment:
    """The record-payment handler enforces the ADR-206 settlement rules (partial, warn)."""

    async def test_partial_allocation_records_payment_and_allocation(self):
        """
        GIVEN a person owing 1000 on one item
        WHEN a 400 payment is allocated to it
        THEN the payment and its allocation are committed (partial settlement)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN
        payment_id = await record_receivable_payment(
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("400"),
                allocations=(AllocationInput(item_id=item_id, amount=Decimal("400")),),
            ),
            uow,
        )

        # THEN
        assert uow.committed is True
        assert uow.committed_receivable_payments[payment_id].amount == Decimal("400")
        allocations = list(uow.committed_receivable_allocations.values())
        assert len(allocations) == 1
        assert allocations[0].item_id == item_id
        assert allocations[0].amount == Decimal("400")

    async def test_multi_item_allocation_splits_one_payment(self):
        """
        GIVEN a person owing on two items
        WHEN a single payment is split across both
        THEN both allocations are committed against the one payment
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_one = _seed_item(uow, person_id=person_id, amount="1000")
        item_two = _seed_item(uow, person_id=person_id, amount="500")

        # WHEN
        payment_id = await record_receivable_payment(
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("1500"),
                allocations=(
                    AllocationInput(item_id=item_one, amount=Decimal("1000")),
                    AllocationInput(item_id=item_two, amount=Decimal("500")),
                ),
            ),
            uow,
        )

        # THEN
        applied = {
            allocation.item_id: allocation.amount
            for allocation in uow.committed_receivable_allocations.values()
            if allocation.payment_id == payment_id
        }
        assert applied == {item_one: Decimal("1000"), item_two: Decimal("500")}

    async def test_exact_settlement_does_not_warn(self):
        """
        GIVEN a person owing exactly 1000
        WHEN a 1000 payment allocates the full amount
        THEN it commits without an overpayment warning (allocated == outstanding)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN
        payment_id = await record_receivable_payment(
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("1000"),
                allocations=(AllocationInput(item_id=item_id, amount=Decimal("1000")),),
            ),
            uow,
        )

        # THEN
        assert payment_id in uow.committed_receivable_payments

    async def test_second_payment_reads_prior_allocations(self):
        """
        GIVEN an item of 1000 already paid down by 400
        WHEN a second 600 payment settles the remaining outstanding
        THEN it commits without a warning (the remainder read nets prior allocations)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        _seed_allocation(uow, person_id=person_id, item_id=item_id, amount="400")

        # WHEN
        payment_id = await record_receivable_payment(
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("600"),
                allocations=(AllocationInput(item_id=item_id, amount=Decimal("600")),),
            ),
            uow,
        )

        # THEN
        assert payment_id in uow.committed_receivable_payments

    async def test_overpayment_warns_without_confirmation(self):
        """
        GIVEN a person owing 1000
        WHEN a payment allocates 1500 (within its own amount) without allow_overpayment
        THEN ReceivableOverpaymentError is raised and nothing is committed (ADR-206)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(ReceivableOverpaymentError) as excinfo:
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=A_USER,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("2000"),
                    allocations=(AllocationInput(item_id=item_id, amount=Decimal("1500")),),
                ),
                uow,
            )
        assert excinfo.value.outstanding == Decimal("1000")
        assert excinfo.value.requested == Decimal("1500")
        assert uow.committed_receivable_payments == {}
        assert uow.committed_receivable_allocations == {}

    async def test_overpayment_allowed_when_confirmed(self):
        """
        GIVEN a person owing 1000
        WHEN a 1500 allocation is confirmed with allow_overpayment
        THEN it commits on purpose, driving the item remainder negative (a credit)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN
        payment_id = await record_receivable_payment(
            RecordReceivablePayment(
                user_id=A_USER,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("2000"),
                allocations=(AllocationInput(item_id=item_id, amount=Decimal("1500")),),
                allow_overpayment=True,
            ),
            uow,
        )

        # THEN
        assert payment_id in uow.committed_receivable_payments
        remainders = await uow.receivables.item_remainders(person_id)
        assert remainders[item_id] == Decimal("-500")  # a confirmed good-faith credit

    async def test_allocations_exceeding_payment_amount_are_rejected(self):
        """
        GIVEN a 400 payment
        WHEN its allocations sum to 500
        THEN AllocationExceedsPaymentError is raised (a hard 422 invariant, ADR-206)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(AllocationExceedsPaymentError):
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=A_USER,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("400"),
                    allocations=(AllocationInput(item_id=item_id, amount=Decimal("500")),),
                ),
                uow,
            )

    async def test_allocation_to_foreign_item_is_not_found(self):
        """
        GIVEN a person with one item
        WHEN a payment allocates to an item id that is not theirs
        THEN ReceivableItemNotFoundError is raised (ADR-206)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=A_USER,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("100"),
                    allocations=(AllocationInput(item_id=uuid4(), amount=Decimal("100")),),
                ),
                uow,
            )

    async def test_missing_person_raises_not_found(self):
        """
        GIVEN no person with the requested id
        WHEN the record-payment handler runs
        THEN PersonNotFoundError is raised (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=A_USER,
                    person_id=uuid4(),
                    occurred_on=A_DATE,
                    amount=Decimal("100"),
                    allocations=(AllocationInput(item_id=uuid4(), amount=Decimal("100")),),
                ),
                uow,
            )

    async def test_cross_tenant_person_raises_not_found(self):
        """
        GIVEN a person owned by user A
        WHEN user B records a payment against it
        THEN PersonNotFoundError is raised (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=ANOTHER_USER,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("100"),
                    allocations=(AllocationInput(item_id=item_id, amount=Decimal("100")),),
                ),
                uow,
            )


class TestConfirmMatchIncomeValidation:
    """Confirm-match validates the linked income before settling (ADR-207).

    The record-payment handler is shared by manual payments and the confirm-match flow. On
    the confirm-match path ONLY (``matched_income_transaction_id`` set) it must reject a
    matched income that does not exist, is owned by another user, or is not a ``kind='income'``
    row (all 404), and one already claimed by another payment (409). Manual payments (no
    matched id) never trigger these checks — covered by :class:`TestRecordReceivablePayment`.
    """

    def _command(self, person_id: UUID, item_id: UUID, income_id: UUID) -> RecordReceivablePayment:
        """Build a confirm-match record-payment command that fully settles a 1000 item."""
        return RecordReceivablePayment(
            user_id=A_USER,
            person_id=person_id,
            occurred_on=A_DATE,
            amount=Decimal("1000"),
            allocations=(AllocationInput(item_id=item_id, amount=Decimal("1000")),),
            source=PaymentSource.MATCHED_INCOME,
            matched_income_transaction_id=income_id,
        )

    async def test_valid_income_settles_through_matched_payment(self):
        """
        GIVEN a person owing 1000 and one of the caller's income transactions
        WHEN the income is confirmed against the item
        THEN a matched-income payment settles the item and is committed (ADR-207)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        income_id = _seed_income(uow, name="Juan")

        # WHEN
        payment_id = await record_receivable_payment(self._command(person_id, item_id, income_id), uow)

        # THEN
        stored = uow.committed_receivable_payments[payment_id]
        assert stored.source is PaymentSource.MATCHED_INCOME
        assert stored.matched_income_transaction_id == income_id

    async def test_nonexistent_income_raises_not_found(self):
        """
        GIVEN no transaction with the matched id
        WHEN the confirm-match handler runs
        THEN MatchedIncomeNotFoundError is raised (404) and nothing is committed
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")

        # WHEN / THEN
        with pytest.raises(MatchedIncomeNotFoundError):
            await record_receivable_payment(self._command(person_id, item_id, uuid4()), uow)
        assert uow.committed_receivable_payments == {}

    async def test_foreign_owner_income_raises_not_found(self):
        """
        GIVEN an income transaction owned by another user
        WHEN the caller confirms it against their person
        THEN MatchedIncomeNotFoundError is raised — existence never leaked (ADR-111)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow, user_id=A_USER)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        income_id = _seed_income(uow, user_id=ANOTHER_USER)

        # WHEN / THEN
        with pytest.raises(MatchedIncomeNotFoundError):
            await record_receivable_payment(self._command(person_id, item_id, income_id), uow)

    async def test_non_income_kind_raises_not_found(self):
        """
        GIVEN one of the caller's transactions that is an EXPENSE, not an income
        WHEN it is confirmed as a matched income
        THEN MatchedIncomeNotFoundError is raised (kind is not income, ADR-207)
        """
        # GIVEN
        uow = FakeUnitOfWork()
        person_id = _seed_person(uow)
        item_id = _seed_item(uow, person_id=person_id, amount="1000")
        expense_id = _seed_income(uow, kind=Kind.EXPENSE)

        # WHEN / THEN
        with pytest.raises(MatchedIncomeNotFoundError):
            await record_receivable_payment(self._command(person_id, item_id, expense_id), uow)

    async def test_already_claimed_income_raises_conflict(self):
        """
        GIVEN an income already linked to one of the caller's payments (claimed)
        WHEN a second confirm-match reuses that same income
        THEN IncomeAlreadyClaimedError is raised (409) — one income never settles two debts
        """
        # GIVEN
        uow = FakeUnitOfWork()
        first_person = _seed_person(uow, name="Juan")
        second_person = _seed_person(uow, name="Ana")
        item_id = _seed_item(uow, person_id=second_person, amount="1000")
        income_id = _seed_income(uow)
        _seed_claimed_payment(uow, person_id=first_person, income_id=income_id)

        # WHEN / THEN
        with pytest.raises(IncomeAlreadyClaimedError):
            await record_receivable_payment(self._command(second_person, item_id, income_id), uow)
        assert uow.committed_receivable_payments  # only the pre-existing claim survives
        assert len(uow.committed_receivable_payments) == 1
