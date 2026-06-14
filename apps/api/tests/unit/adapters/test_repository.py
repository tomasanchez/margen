"""Unit tests for the SQLAlchemy transaction repository (ADR-032).

Per ADR-032 these mock the ``AsyncSession`` and assert the expected calls — no
real database. ``session.add`` is synchronous; ``session.get`` and
``session.delete`` are awaited, so the mock is an ``AsyncMock`` whose synchronous
``add`` is a plain ``MagicMock``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, tzinfo=UTC)


def _aggregate():
    """Build a minimal valid aggregate for repository calls."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=A_DATE,
        name="Coto",
        kind=Kind.EXPENSE,
        amount=Decimal("100"),
        created_at=A_TIME,
        updated_at=A_TIME,
    )


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous add."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


class TestAdd:
    """``add`` stages a mapped record via the session."""

    async def test_add_calls_session_add_with_record(self):
        """
        GIVEN a repository over a mocked session
        WHEN an aggregate is added
        THEN session.add is called once with a mapped TransactionRecord
        """
        # GIVEN
        session = _session()
        repository = SqlAlchemyTransactionRepository(session)
        transaction = _aggregate()

        # WHEN
        repository.add(transaction)

        # THEN
        session.add.assert_called_once()
        (record,) = session.add.call_args.args
        assert isinstance(record, TransactionRecord)
        assert record.id == transaction.id


class TestGet:
    """``get`` awaits ``session.get`` and maps the row."""

    async def test_returns_domain_when_found(self):
        """
        GIVEN a session whose get returns a record
        WHEN the repository loads the aggregate
        THEN session.get is awaited and a domain aggregate is returned
        """
        # GIVEN
        transaction = _aggregate()
        record = TransactionRecord()
        record.id = transaction.id
        record.occurred_on = A_DATE
        record.name = "Coto"
        record.kind = Kind.EXPENSE.value
        record.amount = Decimal("100")
        record.currency = "ARS"
        record.usd_amount = None
        record.fx_rate = None
        record.fx_rate_type = None
        record.fx_rate_as_of = None
        record.category = None
        record.payment_method = None
        record.notes = None
        record.recurring = False
        record.counts_toward_monotributo = False
        record.created_at = A_TIME
        record.updated_at = A_TIME
        session = _session()
        session.get.return_value = record
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        result = await repository.get(transaction.id)

        # THEN
        session.get.assert_awaited_once_with(TransactionRecord, transaction.id)
        assert result is not None
        assert result.id == transaction.id

    async def test_returns_none_when_absent(self):
        """
        GIVEN a session whose get returns None
        WHEN the repository loads the aggregate
        THEN it returns None
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        result = await repository.get(uuid4())

        # THEN
        assert result is None


class TestPersist:
    """``persist`` updates an attached row or inserts when absent."""

    async def test_updates_existing_record(self):
        """
        GIVEN a session whose get returns an attached record
        WHEN a mutated aggregate is persisted
        THEN the record is updated in place and no insert is staged
        """
        # GIVEN
        transaction = _aggregate()
        record = TransactionRecord()
        session = _session()
        session.get.return_value = record
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        await repository.persist(transaction)

        # THEN
        session.get.assert_awaited_once_with(TransactionRecord, transaction.id)
        session.add.assert_not_called()
        assert record.name == transaction.name

    async def test_inserts_when_row_absent(self):
        """
        GIVEN a session whose get returns None
        WHEN an aggregate is persisted
        THEN the repository stages an insert so the change is not lost
        """
        # GIVEN
        transaction = _aggregate()
        session = _session()
        session.get.return_value = None
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        await repository.persist(transaction)

        # THEN
        session.add.assert_called_once()


class TestDelete:
    """``delete`` removes the row when present (ADR-030)."""

    async def test_deletes_existing_row(self):
        """
        GIVEN a session whose get returns a record
        WHEN the aggregate is deleted
        THEN session.delete is awaited and True is returned
        """
        # GIVEN
        record = TransactionRecord()
        session = _session()
        session.get.return_value = record
        repository = SqlAlchemyTransactionRepository(session)
        transaction_id = uuid4()

        # WHEN
        removed = await repository.delete(transaction_id)

        # THEN
        session.delete.assert_awaited_once_with(record)
        assert removed is True

    async def test_returns_false_when_absent(self):
        """
        GIVEN a session whose get returns None
        WHEN a delete is attempted
        THEN no delete is issued and False is returned
        """
        # GIVEN
        session = _session()
        session.get.return_value = None
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        removed = await repository.delete(uuid4())

        # THEN
        session.delete.assert_not_called()
        assert removed is False
