"""Unit tests for the SQLAlchemy receivables repository (ADR-204, ADR-214, ADR-130).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no real
database (the real SQL is covered by the e2e tier and the integration migration test).
They cover the ``persist_*`` insert-fallback branches, the person mapper's owner-less
guard, and the cuota-schedule write ordering the in-memory SQLite tier cannot prove: the
item is flushed before its cuotas are inserted (FK order on PostgreSQL), and replaced cuotas
are deleted and flushed before their replacements are inserted (``UNIQUE (item_id, index)``).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from sqlalchemy.dialects import postgresql

from margen_api.adapters.models.receivable import (
    PersonRecord,
    ReceivableInstallmentRecord,
    ReceivableItemRecord,
)
from margen_api.adapters.receivable_queries import (
    SqlAlchemyReceivableRepository,
    _installment_record,
    _item_record,
    _item_to_domain,
    _person_record,
)
from margen_api.domain.models.receivable import InstallmentPlan, build_person, build_receivable_item

A_TIME = datetime(2026, 1, 1, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"
FIRST_DUE = date(2026, 9, 10)


def _session(stored_installments: list[ReceivableInstallmentRecord] | None = None) -> AsyncMock:
    """Build a mocked AsyncSession with synchronous add/add_all and a canned cuota select.

    ``execute`` answers every select with ``stored_installments`` (empty by default) so the
    schedule sync sees exactly those rows as already stored.
    """
    session = AsyncMock()
    session.add = MagicMock()
    session.add_all = MagicMock()
    result = MagicMock()
    result.scalars.return_value = list(stored_installments or [])
    session.execute.return_value = result
    return session


def _person():
    """Build a minimal valid person aggregate."""
    return build_person(person_id=uuid4(), name="Juan", user_id=A_USER, created_at=A_TIME)


def _item(person_id, *, cuotas: int | None = None):
    """Build a minimal valid receivable item aggregate, optionally split into cuotas."""
    return build_receivable_item(
        item_id=uuid4(),
        person_id=person_id,
        occurred_on=date(2026, 8, 1),
        amount=Decimal("1000"),
        created_at=A_TIME,
        plan=InstallmentPlan(count=cuotas, first_due_on=FIRST_DUE) if cuotas is not None else None,
    )


class TestPersistPerson:
    """``persist_person`` updates an attached row, or inserts when none is stored."""

    async def test_inserts_when_no_row_exists(self):
        """
        GIVEN no stored row for the person's id
        WHEN persist_person is called
        THEN the person is added as a fresh insert (the change is not lost)
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_person(_person())

        # THEN
        session.add.assert_called_once()

    async def test_updates_attached_row(self):
        """
        GIVEN a stored row for the person's id
        WHEN persist_person renames it
        THEN the attached record's name is updated in place (no new insert)
        """
        # GIVEN
        session = _session()
        record = PersonRecord()
        session.get.return_value = record
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_person(_person())

        # THEN
        session.add.assert_not_called()
        assert record.name == "Juan"


class TestPersistItem:
    """``persist_item`` updates an attached row, or inserts when none is stored."""

    async def test_inserts_when_no_row_exists(self):
        """
        GIVEN no stored row for the item's id
        WHEN persist_item is called
        THEN the item is added as a fresh insert (the change is not lost)
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.persist_item(_item(uuid4()))

        # THEN
        session.add.assert_called_once()

    async def test_updates_attached_row(self):
        """
        GIVEN a stored row for the item's id
        WHEN persist_item is called
        THEN the attached record's mutable fields are updated in place (no new insert)
        """
        # GIVEN
        session = _session()
        record = ReceivableItemRecord()
        session.get.return_value = record
        repo = SqlAlchemyReceivableRepository(session)
        source_id = uuid4()
        item = _item(uuid4())
        item.source_transaction_id = source_id

        # WHEN
        await repo.persist_item(item)

        # THEN
        session.add.assert_not_called()
        assert record.amount == Decimal("1000")
        assert record.source_transaction_id == source_id


class TestInstallmentScheduleWrites:
    """Cuota rows are written in an order PostgreSQL's FK and unique constraints accept (ADR-214)."""

    async def test_add_item_flushes_the_item_before_staging_its_cuotas(self):
        """
        GIVEN an item split into three cuotas
        WHEN add_item stages it
        THEN the item row is added, the session is flushed, and only then are the three cuota
             rows added (receivable_installment.item_id must find its parent, ADR-223)
        """
        # GIVEN
        session = _session()
        repo = SqlAlchemyReceivableRepository(session)
        item = _item(uuid4(), cuotas=3)

        # WHEN
        await repo.add_item(item)

        # THEN — add(item) -> flush() -> add_all(cuotas), in that order.
        order = [name for name, _args, _kwargs in session.mock_calls if name in {"add", "flush", "add_all"}]
        assert order == ["add", "flush", "add_all"]
        staged = session.add_all.call_args.args[0]
        assert [record.id for record in staged] == [installment.id for installment in item.installments]

    async def test_add_flat_item_needs_no_flush(self):
        """
        GIVEN a flat item (no cuotas)
        WHEN add_item stages it
        THEN only the item row is added — no flush, no cuota rows
        """
        # GIVEN
        session = _session()
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        await repo.add_item(_item(uuid4()))

        # THEN
        session.add.assert_called_once()
        session.flush.assert_not_awaited()
        session.add_all.assert_not_called()

    async def test_reschedule_deletes_and_flushes_old_cuotas_before_inserting_new_ones(self):
        """
        GIVEN an item whose stored schedule has 2 cuotas and whose aggregate now carries a new
              3-cuota schedule (fresh ids)
        WHEN persist_item syncs it
        THEN both stored cuotas are deleted and flushed BEFORE the 3 new rows are added, so the
             re-used indexes never collide on UNIQUE (item_id, index) (ADR-216)
        """
        # GIVEN
        person_id = uuid4()
        old = _item(person_id, cuotas=2)
        stored = [_installment_record(installment) for installment in old.installments]
        session = _session(stored)
        session.get.return_value = ReceivableItemRecord()
        repo = SqlAlchemyReceivableRepository(session)
        rescheduled = build_receivable_item(
            item_id=old.id,
            person_id=person_id,
            occurred_on=old.occurred_on,
            amount=Decimal("1000"),
            created_at=A_TIME,
            plan=InstallmentPlan(count=3, first_due_on=FIRST_DUE),
        )

        # WHEN
        await repo.persist_item(rescheduled)

        # THEN — delete, delete, flush, then one add per new cuota.
        order = [name for name, _args, _kwargs in session.mock_calls if name in {"delete", "flush", "add"}]
        assert order == ["delete", "delete", "flush", "add", "add", "add"]
        assert {call.args[0] for call in session.delete.await_args_list} == set(stored)

    async def test_cuota_edit_updates_rows_in_place(self):
        """
        GIVEN an item whose stored cuotas are the same ones (same ids) the aggregate carries
        WHEN persist_item syncs an edited cuota amount
        THEN nothing is deleted, flushed or inserted; the stored row takes the new values
        """
        # GIVEN
        item = _item(uuid4(), cuotas=2)
        stored = [_installment_record(installment) for installment in item.installments]
        session = _session(stored)
        session.get.return_value = ReceivableItemRecord()
        repo = SqlAlchemyReceivableRepository(session)
        edited = item.edit_installment(2, amount=Decimal("650"), due_on=date(2026, 12, 1), paid_by_installment={})

        # WHEN
        await repo.persist_item(edited)

        # THEN
        session.delete.assert_not_awaited()
        session.flush.assert_not_awaited()
        session.add.assert_not_called()
        assert stored[1].amount == Decimal("650.00")
        assert stored[1].due_on == date(2026, 12, 1)


class TestPersonLock:
    """Every receivables write starts by locking the person row (concurrency, ADR-130)."""

    async def test_locks_the_person_row_for_update(self):
        """
        GIVEN a repository over a mocked session
        WHEN the person is locked
        THEN the statement asks for a row lock: SELECT ... FOR UPDATE on PostgreSQL
        """
        # GIVEN
        session = _session()
        session.execute.return_value.scalar_one_or_none.return_value = None
        repo = SqlAlchemyReceivableRepository(session)

        # WHEN
        locked = await repo.lock_person(uuid4(), A_USER)

        # THEN
        statement = session.execute.await_args.args[0]
        assert locked is None
        assert str(statement.compile(dialect=postgresql.dialect())).endswith("FOR UPDATE")


class TestTolerantRehydration:
    """A stored amount that disagrees with the cuotas never breaks a read (ADR-216)."""

    def test_the_cuota_sum_wins_and_the_mismatch_is_logged(self, caplog: pytest.LogCaptureFixture):
        """
        GIVEN a 3-cuota item (1000) whose stored row says 999
        WHEN it is rehydrated
        THEN the item amount is the cuota sum, 1000.00, and a warning names the mismatch
        """
        # GIVEN
        item = _item(uuid4(), cuotas=3)
        record = _item_record(item)
        record.amount = Decimal("999")

        # WHEN
        rehydrated = _item_to_domain(record, item.installments)

        # THEN
        assert rehydrated.amount == Decimal("1000.00")
        assert "using the cuota sum" in caplog.text


class TestPersonMapperOwnershipGuard:
    """The person mapper refuses to persist a person with no owning user_id (ADR-130)."""

    async def test_person_record_without_user_id_raises(self):
        """
        GIVEN a person aggregate carrying no user_id
        WHEN it is mapped to a record
        THEN a ValueError is raised (a missing owner is a programming error)
        """
        # GIVEN
        person = build_person(person_id=uuid4(), name="Juan", user_id=None, created_at=A_TIME)

        # WHEN / THEN
        with pytest.raises(ValueError, match="owning user_id"):
            _person_record(person)
