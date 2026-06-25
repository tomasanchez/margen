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
from uuid import UUID, uuid4

from sqlalchemy import Select

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


def _aggregate():
    """Build a minimal valid aggregate for repository calls."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=A_DATE,
        name="Coto",
        kind=Kind.EXPENSE,
        amount=Decimal("100"),
        user_id=A_USER,
        created_at=A_TIME,
        updated_at=A_TIME,
    )


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous add."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


def _execute_result(record: object) -> MagicMock:
    """Wrap a record (or ``None``) in a fake execute result exposing ``scalar_one_or_none``."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = record
    return result


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
    """``get`` runs an owner-scoped select and maps the row (ADR-108, ADR-111)."""

    async def test_returns_domain_when_found(self):
        """
        GIVEN a session whose owner-scoped select returns a record
        WHEN the repository loads the aggregate
        THEN an owner-filtered Select runs and a domain aggregate is returned
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
        record.user_id = UUID(A_USER)
        record.created_at = A_TIME
        record.updated_at = A_TIME
        session = _session()
        session.execute.return_value = _execute_result(record)
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        result = await repository.get(transaction.id, A_USER)

        # THEN — an owner-scoped Select was executed.
        session.execute.assert_awaited_once()
        (statement,) = session.execute.call_args.args
        assert isinstance(statement, Select)
        assert "user_id" in str(statement).lower()
        assert result is not None
        assert result.id == transaction.id

    async def test_returns_none_when_absent_or_cross_tenant(self):
        """
        GIVEN a session whose owner-scoped select returns None
        WHEN the repository loads the aggregate
        THEN it returns None (a foreign owner's id is simply not found, ADR-111)
        """
        # GIVEN
        session = _session()
        session.execute.return_value = _execute_result(None)
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        result = await repository.get(uuid4(), A_USER)

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
    """``delete`` removes the owner's row when present (ADR-030, ADR-108)."""

    async def test_deletes_existing_row(self):
        """
        GIVEN a session whose owner-scoped select returns a record
        WHEN the aggregate is deleted
        THEN an owner-filtered Select runs, session.delete is awaited and True returned
        """
        # GIVEN
        record = TransactionRecord()
        session = _session()
        session.execute.return_value = _execute_result(record)
        repository = SqlAlchemyTransactionRepository(session)
        transaction_id = uuid4()

        # WHEN
        removed = await repository.delete(transaction_id, A_USER)

        # THEN
        session.execute.assert_awaited_once()
        (statement,) = session.execute.call_args.args
        assert isinstance(statement, Select)
        assert "user_id" in str(statement).lower()
        session.delete.assert_awaited_once_with(record)
        assert removed is True

    async def test_returns_false_when_absent_or_cross_tenant(self):
        """
        GIVEN a session whose owner-scoped select returns None
        WHEN a delete is attempted
        THEN no delete is issued and False is returned (cross-tenant is a miss, ADR-111)
        """
        # GIVEN
        session = _session()
        session.execute.return_value = _execute_result(None)
        repository = SqlAlchemyTransactionRepository(session)

        # WHEN
        removed = await repository.delete(uuid4(), A_USER)

        # THEN
        session.delete.assert_not_called()
        assert removed is False
