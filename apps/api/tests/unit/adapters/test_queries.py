"""Unit tests for the SQLAlchemy transaction reader (ADR-032).

Per ADR-032 these mock the ``AsyncSession`` and the execute result — no real
database. They assert the reader builds a newest-first ``select`` and projects
rows into read models.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from sqlalchemy import Select

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.queries import SqlAlchemyTransactionReader
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, tzinfo=UTC)


def _record(kind: str = "expense", currency: str = "ARS", fx_rate_type: str | None = None) -> TransactionRecord:
    """Build a populated record for projection."""
    record = TransactionRecord()
    record.id = uuid4()
    record.occurred_on = A_DATE
    record.name = "Coto"
    record.kind = kind
    record.amount = Decimal("100")
    record.currency = currency
    record.usd_amount = Decimal("1") if currency == "USD" else None
    record.fx_rate = None
    record.fx_rate_type = fx_rate_type
    record.fx_rate_as_of = None
    record.category = None
    record.payment_method = None
    record.notes = None
    record.recurring = False
    record.counts_toward_monotributo = False
    record.created_at = A_TIME
    record.updated_at = A_TIME
    return record


class TestListTransactions:
    """``list_transactions`` selects newest-first and projects read models."""

    async def test_builds_ordered_select_and_projects(self):
        """
        GIVEN a session whose execute returns two records
        WHEN list_transactions runs
        THEN a Select ordered by occurred_on desc is executed and read models returned
        """
        # GIVEN
        records = [_record(kind="invoice"), _record(currency="USD", fx_rate_type="MEP")]
        result = MagicMock()
        result.scalars.return_value.all.return_value = records
        session = AsyncMock()
        session.execute.return_value = result
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        models = await reader.list_transactions()

        # THEN
        session.execute.assert_awaited_once()
        (statement,) = session.execute.call_args.args
        assert isinstance(statement, Select)
        # The ordering clause sorts by occurred_on then created_at, descending.
        compiled = str(statement).lower()
        assert "order by" in compiled
        assert "occurred_on desc" in compiled
        assert len(models) == 2
        # Derived type and parsed enums come through the projection.
        assert models[0].type is TxType.INCOME
        assert models[1].currency is Currency.USD
        assert models[1].fx_rate_type is FxRateType.MEP

    async def test_empty_result(self):
        """
        GIVEN a session whose execute returns no records
        WHEN list_transactions runs
        THEN an empty list is returned
        """
        # GIVEN
        result = MagicMock()
        result.scalars.return_value.all.return_value = []
        session = AsyncMock()
        session.execute.return_value = result
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        models = await reader.list_transactions()

        # THEN
        assert models == []


class TestGetTransaction:
    """``get_transaction`` fetches one row by identity and projects it."""

    async def test_returns_read_model_when_found(self):
        """
        GIVEN a session whose get returns a record
        WHEN get_transaction runs
        THEN session.get is awaited and a read model is returned
        """
        # GIVEN
        record = _record(kind="expense")
        session = AsyncMock()
        session.get.return_value = record
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        model = await reader.get_transaction(record.id)

        # THEN
        session.get.assert_awaited_once_with(TransactionRecord, record.id)
        assert model is not None
        assert model.kind is Kind.EXPENSE
        assert model.type is TxType.EXPENSE

    async def test_returns_none_when_absent(self):
        """
        GIVEN a session whose get returns None
        WHEN get_transaction runs
        THEN it returns None
        """
        # GIVEN
        session = AsyncMock()
        session.get.return_value = None
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        model = await reader.get_transaction(uuid4())

        # THEN
        assert model is None
