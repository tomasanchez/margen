"""SQLAlchemy reader for the transaction query side (ADR-028, ADR-030).

The reader runs read-only queries against an ``AsyncSession`` and projects rows
into :class:`TransactionReadModel` DTOs. It never returns write aggregates and
never mutates state, so it can be wired independently of the unit of work
(AGENTS.md reader ports + read models). All I/O is awaited.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.summaries import (
    UNCATEGORIZED,
    build_monthly_summary,
    trend_window,
)
from margen_api.service_layer.summary_read_models import MonthlySummary
from margen_api.service_layer.summary_reader import AbstractSummaryReader


def _to_read_model(record: TransactionRecord) -> TransactionReadModel:
    """Project a persisted row into a read model, deriving ``type`` from ``kind``."""
    kind = Kind.parse(record.kind)
    return TransactionReadModel(
        id=record.id,
        occurred_on=record.occurred_on,
        name=record.name,
        kind=kind,
        type=TxType.EXPENSE if kind is Kind.EXPENSE else TxType.INCOME,
        amount=record.amount,
        currency=Currency.parse(record.currency),
        usd_amount=record.usd_amount,
        fx_rate=record.fx_rate,
        fx_rate_type=FxRateType(record.fx_rate_type) if record.fx_rate_type is not None else None,
        fx_rate_as_of=record.fx_rate_as_of,
        category=record.category,
        payment_method=record.payment_method,
        notes=record.notes,
        recurring=record.recurring,
        counts_toward_monotributo=record.counts_toward_monotributo,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


class SqlAlchemyTransactionReader(AbstractTransactionReader):
    """Serve transaction read models from an async session."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def list_transactions(self) -> list[TransactionReadModel]:
        """List all transactions newest-first by ``occurred_on`` (ADR-030)."""
        statement = select(TransactionRecord).order_by(
            TransactionRecord.occurred_on.desc(),
            TransactionRecord.created_at.desc(),
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]

    async def get_transaction(self, transaction_id: UUID) -> TransactionReadModel | None:
        """Fetch one transaction read model, or ``None`` when absent."""
        record = await self.session.get(TransactionRecord, transaction_id)
        if record is None:
            return None
        return _to_read_model(record)


# The persisted amount is ``NUMERIC(18, 2)``; SUM widens it, so cast the result
# back to NUMERIC so the driver returns a Decimal (not a float) for money (ADR-025).
_EXPENSE_AMOUNT = cast(func.sum(TransactionRecord.amount), Numeric(18, 2))
# Year and month derived from ``occurred_on`` — portable across PostgreSQL and the
# in-memory SQLite the offline tier uses (avoids ``date_trunc``).
_YEAR = func.extract("year", TransactionRecord.occurred_on)
_MONTH = func.extract("month", TransactionRecord.occurred_on)
# Null categories bucket under a single "Uncategorized" label (ADR-042).
_CATEGORY = func.coalesce(TransactionRecord.category, UNCATEGORIZED)


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class SqlAlchemySummaryReader(AbstractSummaryReader):
    """Serve the monthly summary from server-side SQL aggregation (ADR-042).

    Runs read-only ``SUM`` / ``GROUP BY`` queries over the ``transactions`` table
    filtered to ``kind = 'expense'`` and projects the totals into a
    :class:`MonthlySummary`. SQLAlchemy stays in this adapter; the trend, share
    and delta math lives in the pure :mod:`margen_api.service_layer.summaries`.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def monthly_summary(self, month: date) -> MonthlySummary:
        """Aggregate the 6-month trend and the month's category breakdown."""
        window = trend_window(month)
        prior = window[-2]
        requested = window[-1]

        trend_totals = await self._trend_totals(window[0], requested)
        month_category_totals = await self._category_totals(requested)
        prior_category_totals = await self._category_totals(prior)

        return build_monthly_summary(
            month,
            trend_totals=trend_totals,
            month_category_totals=month_category_totals,
            prior_category_totals=prior_category_totals,
        )

    async def _trend_totals(self, oldest: date, newest: date) -> dict[str, Decimal]:
        """Return expense totals keyed by ``YYYY-MM`` across the trend window.

        Groups expenses by ``(year, month)`` over the inclusive range from the
        first day of ``oldest`` to the last day of ``newest``.
        """
        upper = date(newest.year + (newest.month // 12), (newest.month % 12) + 1, 1)
        statement = (
            select(_YEAR.label("year"), _MONTH.label("month"), _EXPENSE_AMOUNT.label("total"))
            .where(
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.occurred_on >= oldest,
                TransactionRecord.occurred_on < upper,
            )
            .group_by(_YEAR, _MONTH)
        )
        result = await self.session.execute(statement)
        return {f"{int(row.year):04d}-{int(row.month):02d}": _as_decimal(row.total) for row in result.all()}

    async def _category_totals(self, month: date) -> dict[str, Decimal]:
        """Return the month's expense totals keyed by category."""
        upper = date(month.year + (month.month // 12), (month.month % 12) + 1, 1)
        statement = (
            select(_CATEGORY.label("category"), _EXPENSE_AMOUNT.label("total"))
            .where(
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.occurred_on >= month,
                TransactionRecord.occurred_on < upper,
            )
            .group_by(_CATEGORY)
        )
        result = await self.session.execute(statement)
        return {str(row.category): _as_decimal(row.total) for row in result.all()}
