"""Integration proof that receivables writes on one person are serialized (ADR-130, ADR-216).

Marked ``integration`` (ADR-032): runs only against a real PostgreSQL, because the guarantee is
a row lock — every receivables write handler starts with ``SELECT ... FOR UPDATE`` on the person
(the aggregate root), which SQLite does not have. Each test holds that lock in one session,
starts a real handler in another, proves the handler waits, then releases the lock and checks
the handler worked from the committed state instead of a stale snapshot:

* two cuota edits never lose one another (the lost update a stale read used to cause);
* a payment racing a re-schedule cannot allocate to a cuota the re-schedule replaced (the
  allocation would otherwise be cascaded away right after being recorded).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.models.receivable import ReceivableAllocationRecord, ReceivablePaymentRecord
from margen_api.adapters.receivable_queries import SqlAlchemyReceivableRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.receivable import (
    AddReceivableItem,
    AllocationInput,
    CreatePerson,
    EditReceivableInstallment,
    NewInstallmentPlanInput,
    RecordReceivablePayment,
)
from margen_api.domain.models.exceptions import ReceivableInstallmentNotFoundError
from margen_api.domain.models.receivable import InstallmentPlan
from margen_api.service_layer.receivables import (
    add_receivable_item,
    create_person,
    edit_receivable_installment,
    record_receivable_payment,
)

pytestmark = pytest.mark.integration

OWNER = "77777777-7777-4777-8777-777777777777"
FIRST_DUE = date(2026, 7, 10)
AS_OF = date(2026, 8, 10)

# How long the competing handler is given to (wrongly) get past the lock before we check it is
# still waiting; generous enough for a slow CI runner, short enough to keep the tier fast.
_WAIT = 0.5


async def _seed_plan(session_factory: async_sessionmaker[AsyncSession]) -> tuple[UUID, UUID]:
    """Create a person with a 3 x 1000 installment item through the real handlers."""
    uow = SqlAlchemyUnitOfWork(session_factory)
    person_id = await create_person(CreatePerson(user_id=OWNER, name="Juan"), uow)
    item_id = await add_receivable_item(
        AddReceivableItem(
            user_id=OWNER,
            person_id=person_id,
            occurred_on=date(2026, 7, 1),
            amount=Decimal("3000"),
            installments=NewInstallmentPlanInput(count=3, first_due_on=FIRST_DUE),
        ),
        uow,
    )
    return person_id, item_id


async def _count(session_factory: async_sessionmaker[AsyncSession], record: type) -> int:
    """Return the number of rows in ``record``'s table."""
    async with session_factory() as session:
        return int((await session.execute(select(func.count()).select_from(record))).scalar_one())


class TestWritesOnOnePersonAreSerialized:
    """The person row lock makes concurrent receivables writes run one after the other."""

    async def test_concurrent_cuota_edits_never_lose_one_another(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a 3 x 1000 plan, and a transaction holding the person lock that edits cuota 1
        WHEN another request edits cuota 2 meanwhile
        THEN it waits for the lock, then applies its edit on top of the committed one: cuotas
             read 1200 / 1500 / 1000 and the item amount is their sum, 3700
        """
        # GIVEN
        person_id, item_id = await _seed_plan(session_factory)
        async with session_factory() as holder:
            repo = SqlAlchemyReceivableRepository(holder)
            assert await repo.lock_person(person_id, OWNER) is not None

            # WHEN — the competing edit starts while the lock is held, and must wait.
            competing = asyncio.create_task(
                edit_receivable_installment(
                    EditReceivableInstallment(
                        item_id=item_id, person_id=person_id, user_id=OWNER, index=2, amount=Decimal("1500")
                    ),
                    SqlAlchemyUnitOfWork(session_factory),
                )
            )
            await asyncio.sleep(_WAIT)
            assert not competing.done()

            # AND — the lock holder edits cuota 1 and commits, releasing the lock.
            item = await repo.get_item(item_id, OWNER)
            assert item is not None
            await repo.persist_item(item.edit_installment(1, amount=Decimal("1200"), paid_by_installment={}))
            await holder.commit()
        await asyncio.wait_for(competing, timeout=10)

        # THEN — both edits survive.
        async with session_factory() as session:
            final = await SqlAlchemyReceivableRepository(session).get_item(item_id, OWNER)
        assert final is not None
        assert [cuota.amount for cuota in final.installments] == [
            Decimal("1200.00"),
            Decimal("1500.00"),
            Decimal("1000.00"),
        ]
        assert final.amount == Decimal("3700.00")

    async def test_a_payment_racing_a_reschedule_cannot_target_a_replaced_cuota(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a 3 x 1000 plan, and a transaction holding the person lock that re-schedules it
              into 6 cuotas (new cuota rows)
        WHEN a payment for one of the OLD cuotas is recorded meanwhile
        THEN the payment waits, then finds its cuota gone and is refused — no payment and no
             allocation are written (none can be cascaded away behind the owner's back)
        """
        # GIVEN
        person_id, item_id = await _seed_plan(session_factory)
        async with session_factory() as session:
            seeded = await SqlAlchemyReceivableRepository(session).get_item(item_id, OWNER)
        assert seeded is not None
        old_cuota = seeded.installments[0].id
        async with session_factory() as holder:
            repo = SqlAlchemyReceivableRepository(holder)
            assert await repo.lock_person(person_id, OWNER) is not None

            # WHEN — the payment starts while the lock is held, and must wait.
            payment = asyncio.create_task(
                record_receivable_payment(
                    RecordReceivablePayment(
                        user_id=OWNER,
                        person_id=person_id,
                        occurred_on=AS_OF,
                        amount=Decimal("1000"),
                        allocations=(
                            AllocationInput(item_id=item_id, installment_id=old_cuota, amount=Decimal("1000")),
                        ),
                        as_of=AS_OF,
                    ),
                    SqlAlchemyUnitOfWork(session_factory),
                )
            )
            await asyncio.sleep(_WAIT)
            assert not payment.done()

            # AND — the lock holder re-schedules the plan and commits.
            current = await repo.get_item(item_id, OWNER)
            assert current is not None
            reshaped = current.revise(
                amount=None,
                plan=InstallmentPlan(count=6, first_due_on=FIRST_DUE),
                has_allocations=False,
                created_at=datetime.now(UTC),
            )
            await repo.persist_item(reshaped)
            await holder.commit()

        # THEN — the payment, now reading the committed plan, no longer finds its cuota.
        with pytest.raises(ReceivableInstallmentNotFoundError):
            await asyncio.wait_for(payment, timeout=10)
        assert await _count(session_factory, ReceivablePaymentRecord) == 0
        assert await _count(session_factory, ReceivableAllocationRecord) == 0
