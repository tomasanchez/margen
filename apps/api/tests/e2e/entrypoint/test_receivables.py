"""End-to-end tests for the receivables service layer over real SQLite (ADR-204, ADR-206).

The REST routers for receivables land in a later slice, so these drive the application
handlers through the **REAL** ``SqlAlchemyUnitOfWork`` and read back through the **REAL**
``SqlAlchemyReceivableReader``, both on in-memory async SQLite (ADR-019/032). That
genuinely persists people/items/payments/allocations and exercises the owner-scoped SQL,
the per-item remainder roll-ups and the ADR-206 overpayment guard end to end — the same
tier the routed CRUD features use, minus the HTTP edge. Cross-tenant isolation uses the
second stub identity (ADR-113).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from margen_api.adapters.receivable_queries import SqlAlchemyReceivableReader
from margen_api.bootstrap import ApplicationContainer
from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
    CreatePerson,
    DeletePerson,
    DeleteReceivableItem,
    EditReceivableItem,
    RecordReceivablePayment,
    RenamePerson,
    SetReceivableItemPardon,
)
from margen_api.domain.models.exceptions import (
    PersonNotFoundError,
    ReceivableItemNotFoundError,
    ReceivableOverpaymentError,
)
from margen_api.service_layer.receivable_read_models import PersonDetailReadModel
from margen_api.service_layer.receivables import (
    add_receivable_item,
    create_person,
    delete_person,
    delete_receivable_item,
    edit_receivable_item,
    record_receivable_payment,
    rename_person,
    set_receivable_item_pardon,
)
from tests.conftest import STUB_USER_ID, STUB_USER_ID_B

A_DATE = date(2026, 8, 1)


async def _list_outstanding(container: ApplicationContainer, user_id: str) -> dict[str, Decimal]:
    """Return a name -> outstanding map from the real people-list reader."""
    session = container.session_factory()
    try:
        people = await SqlAlchemyReceivableReader(session).list_people(user_id)
        return {person.name: person.outstanding for person in people}
    finally:
        await session.close()


async def _detail(container: ApplicationContainer, person_id: UUID, user_id: str) -> PersonDetailReadModel | None:
    """Return the real per-person detail read model (or ``None``)."""
    session = container.session_factory()
    try:
        return await SqlAlchemyReceivableReader(session).get_person(person_id, user_id)
    finally:
        await session.close()


class TestPersonAndItemPersistence:
    """People, items and their remainder roll-ups persist and read back (ADR-204, ADR-206)."""

    async def test_create_person_then_list_shows_zero_outstanding(self, container: ApplicationContainer):
        """
        GIVEN a freshly created person with no items
        WHEN the people list is read
        THEN the person appears with a zero outstanding total
        """
        # WHEN
        await create_person(CreatePerson(user_id=STUB_USER_ID, name="Juan"), container.uow_factory())

        # THEN
        assert await _list_outstanding(container, STUB_USER_ID) == {"Juan": Decimal("0.00")}

    async def test_items_roll_up_into_person_outstanding(self, container: ApplicationContainer):
        """
        GIVEN a person with two itemized debts
        WHEN the person detail is read
        THEN each item carries its remainder and the person outstanding sums them
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Ana"), container.uow_factory())
        await add_receivable_item(
            AddReceivableItem(
                user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1000"), detail="lunch"
            ),
            container.uow_factory(),
        )
        await add_receivable_item(
            AddReceivableItem(
                user_id=STUB_USER_ID, person_id=person_id, occurred_on=date(2026, 9, 1), amount=Decimal("500")
            ),
            container.uow_factory(),
        )

        # WHEN
        detail = await _detail(container, person_id, STUB_USER_ID)

        # THEN — newest item (Sept) first; remainders equal amounts with no payments yet.
        assert detail is not None
        assert detail.outstanding == Decimal("1500.00")
        assert [item.amount for item in detail.items] == [Decimal("500.00"), Decimal("1000.00")]
        assert detail.items[1].detail == "lunch"
        assert all(item.allocated == Decimal("0") for item in detail.items)

    async def test_recorded_payment_reduces_remainders(self, container: ApplicationContainer):
        """
        GIVEN a person owing 1000 on one item and 500 on another
        WHEN one payment is split 600/500 across them
        THEN the per-item remainders and the person outstanding drop accordingly
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Beto"), container.uow_factory())
        big = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1000")),
            container.uow_factory(),
        )
        small = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("500")),
            container.uow_factory(),
        )

        # WHEN
        await record_receivable_payment(
            RecordReceivablePayment(
                user_id=STUB_USER_ID,
                person_id=person_id,
                occurred_on=A_DATE,
                amount=Decimal("1100"),
                allocations=(
                    AllocationInput(item_id=big, amount=Decimal("600")),
                    AllocationInput(item_id=small, amount=Decimal("500")),
                ),
            ),
            container.uow_factory(),
        )

        # THEN
        detail = await _detail(container, person_id, STUB_USER_ID)
        assert detail is not None
        assert detail.outstanding == Decimal("400.00")
        remaining = {item.id: item.remaining for item in detail.items}
        assert remaining[big] == Decimal("400.00")
        assert remaining[small] == Decimal("0.00")

    async def test_rename_and_edit_and_deletes_persist(self, container: ApplicationContainer):
        """
        GIVEN a person with two items
        WHEN the person is renamed, an item is edited and one item is deleted
        THEN the detail reflects the new name, edited amount and the removed item
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Old"), container.uow_factory())
        keep = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1000")),
            container.uow_factory(),
        )
        drop = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("500")),
            container.uow_factory(),
        )

        # WHEN
        await rename_person(RenamePerson(id=person_id, user_id=STUB_USER_ID, name="New"), container.uow_factory())
        await edit_receivable_item(
            EditReceivableItem(id=keep, user_id=STUB_USER_ID, amount=Decimal("800"), detail="updated"),
            container.uow_factory(),
        )
        await delete_receivable_item(DeleteReceivableItem(id=drop, user_id=STUB_USER_ID), container.uow_factory())

        # THEN
        detail = await _detail(container, person_id, STUB_USER_ID)
        assert detail is not None
        assert detail.name == "New"
        assert [item.id for item in detail.items] == [keep]
        assert detail.items[0].amount == Decimal("800.00")
        assert detail.items[0].detail == "updated"

    async def test_delete_person_removes_them_from_the_list(self, container: ApplicationContainer):
        """
        GIVEN a created person
        WHEN the person is deleted
        THEN they no longer appear in the people list
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Gone"), container.uow_factory())

        # WHEN
        await delete_person(DeletePerson(id=person_id, user_id=STUB_USER_ID), container.uow_factory())

        # THEN
        assert await _list_outstanding(container, STUB_USER_ID) == {}


class TestPardonExclusion:
    """Pardoning an item drops it from outstanding over real SQL, reversibly (ADR-210)."""

    async def test_pardon_excludes_from_outstanding_and_flags_item_then_unpardon_restores(
        self, container: ApplicationContainer
    ):
        """
        GIVEN a person with a live 1000 item and a 5000 item
        WHEN the 5000 item is pardoned
        THEN the person's outstanding drops to 1000, the item is flagged pardoned, and the
             people-list outstanding excludes it too; un-pardoning restores 6000
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Deb"), container.uow_factory())
        await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1000")),
            container.uow_factory(),
        )
        big = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("5000")),
            container.uow_factory(),
        )

        # WHEN — the 5000 item is forgiven.
        await set_receivable_item_pardon(
            SetReceivableItemPardon(id=big, user_id=STUB_USER_ID, pardoned=True), container.uow_factory()
        )

        # THEN — the person now owes only the live 1000; the pardoned item is flagged and kept.
        detail = await _detail(container, person_id, STUB_USER_ID)
        assert detail is not None
        assert detail.outstanding == Decimal("1000.00")
        pardoned = {item.id: item.pardoned for item in detail.items}
        assert pardoned[big] is True
        # AND — the people-list roll-up excludes the pardoned item as well.
        assert await _list_outstanding(container, STUB_USER_ID) == {"Deb": Decimal("1000.00")}

        # WHEN — the pardon is reversed.
        await set_receivable_item_pardon(
            SetReceivableItemPardon(id=big, user_id=STUB_USER_ID, pardoned=False), container.uow_factory()
        )

        # THEN — the full 6000 is owed again and the flag clears.
        restored = await _detail(container, person_id, STUB_USER_ID)
        assert restored is not None
        assert restored.outstanding == Decimal("6000.00")
        assert all(item.pardoned is False for item in restored.items)

    async def test_person_with_only_pardoned_items_still_lists_with_zero(self, container: ApplicationContainer):
        """
        GIVEN a person whose only item is pardoned
        WHEN the people list is read
        THEN the person still appears with a zero outstanding (not dropped, ADR-210)
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Solo"), container.uow_factory())
        only = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("2000")),
            container.uow_factory(),
        )

        # WHEN
        await set_receivable_item_pardon(
            SetReceivableItemPardon(id=only, user_id=STUB_USER_ID, pardoned=True), container.uow_factory()
        )

        # THEN — the person is retained in the list with a zero outstanding.
        assert await _list_outstanding(container, STUB_USER_ID) == {"Solo": Decimal("0.00")}


class TestOwnerScoping:
    """Every read and write is scoped to the owner (ADR-130, ADR-111)."""

    async def test_people_list_never_leaks_across_tenants(self, container: ApplicationContainer):
        """
        GIVEN user A created a person
        WHEN user B lists people
        THEN B sees none of A's people
        """
        # GIVEN
        await create_person(CreatePerson(user_id=STUB_USER_ID, name="A's person"), container.uow_factory())

        # WHEN / THEN
        assert await _list_outstanding(container, STUB_USER_ID_B) == {}

    async def test_detail_of_foreign_person_is_none(self, container: ApplicationContainer):
        """
        GIVEN a person owned by user A
        WHEN user B reads that person's detail
        THEN the reader returns None (existence is never leaked, ADR-111)
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="A"), container.uow_factory())

        # WHEN / THEN
        assert await _detail(container, person_id, STUB_USER_ID_B) is None

    async def test_detail_of_unknown_person_is_none(self, container: ApplicationContainer):
        """
        GIVEN no person with a random id
        WHEN the detail is read
        THEN the reader returns None
        """
        # WHEN / THEN
        assert await _detail(container, uuid4(), STUB_USER_ID) is None


class TestNotFoundAndWarningPaths:
    """The handlers surface the not-found and overpayment conditions over real SQL."""

    async def test_add_item_to_missing_person_raises(self, container: ApplicationContainer):
        """
        GIVEN no person with a random id
        WHEN an item is added to it
        THEN PersonNotFoundError is raised (the real owner-scoped lookup misses)
        """
        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await add_receivable_item(
                AddReceivableItem(user_id=STUB_USER_ID, person_id=uuid4(), occurred_on=A_DATE, amount=Decimal("1")),
                container.uow_factory(),
            )

    async def test_delete_missing_person_raises(self, container: ApplicationContainer):
        """
        GIVEN no person with a random id
        WHEN it is deleted
        THEN PersonNotFoundError is raised (the delete reports a miss)
        """
        # WHEN / THEN
        with pytest.raises(PersonNotFoundError):
            await delete_person(DeletePerson(id=uuid4(), user_id=STUB_USER_ID), container.uow_factory())

    async def test_edit_missing_item_raises(self, container: ApplicationContainer):
        """
        GIVEN no item with a random id
        WHEN it is edited
        THEN ReceivableItemNotFoundError is raised (the joined lookup misses)
        """
        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await edit_receivable_item(
                EditReceivableItem(id=uuid4(), user_id=STUB_USER_ID, amount=Decimal("1")),
                container.uow_factory(),
            )

    async def test_delete_missing_item_raises(self, container: ApplicationContainer):
        """
        GIVEN no item with a random id
        WHEN it is deleted
        THEN ReceivableItemNotFoundError is raised (the delete reports a miss)
        """
        # WHEN / THEN
        with pytest.raises(ReceivableItemNotFoundError):
            await delete_receivable_item(
                DeleteReceivableItem(id=uuid4(), user_id=STUB_USER_ID), container.uow_factory()
            )

    async def test_overpayment_warns_over_real_remainders(self, container: ApplicationContainer):
        """
        GIVEN a person owing 1000 computed by the real remainder SQL
        WHEN a payment allocates 1500 without confirmation
        THEN ReceivableOverpaymentError surfaces the outstanding/requested figures
        """
        # GIVEN
        person_id = await create_person(CreatePerson(user_id=STUB_USER_ID, name="Owes"), container.uow_factory())
        item_id = await add_receivable_item(
            AddReceivableItem(user_id=STUB_USER_ID, person_id=person_id, occurred_on=A_DATE, amount=Decimal("1000")),
            container.uow_factory(),
        )

        # WHEN / THEN
        with pytest.raises(ReceivableOverpaymentError) as excinfo:
            await record_receivable_payment(
                RecordReceivablePayment(
                    user_id=STUB_USER_ID,
                    person_id=person_id,
                    occurred_on=A_DATE,
                    amount=Decimal("2000"),
                    allocations=(AllocationInput(item_id=item_id, amount=Decimal("1500")),),
                ),
                container.uow_factory(),
            )
        assert excinfo.value.outstanding == Decimal("1000.00")
        assert excinfo.value.requested == Decimal("1500")
