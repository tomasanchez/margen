"""Integration tests for the insights reader against real PostgreSQL (ADR-060, ADR-061).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove the server-side ``SUM`` / ``GROUP BY`` / latest-row aggregation, the
prior-month mover delta, the recurring footprint, the income-minus-expense
savings and the latest-USD-invoice selection actually work end to end over real
data — what the mocked fast tiers cannot verify. A fixed reference date keeps the
savings projection deterministic and clock-independent.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.queries import SqlAlchemyInsightsReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind

pytestmark = pytest.mark.integration

# A stable creation timestamp so the latest-USD tiebreak is deterministic.
_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _expense(occurred_on: date, amount: str, category: str | None, *, recurring: bool = False, name: str = "Spend"):
    """Build an ARS expense aggregate for a date and category."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category=category,
        recurring=recurring,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _income(occurred_on: date, amount: str, kind: Kind = Kind.INCOME):
    """Build an inflow (income or invoice) aggregate feeding savings."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Inflow",
        kind=kind,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Income",
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _usd_invoice(occurred_on: date, usd: str, rate: str, created_at: datetime):
    """Build a USD invoice carrying an applied rate (latest-USD input)."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="USD invoice",
        kind=Kind.INVOICE,
        amount=Decimal(usd) * Decimal(rate),
        currency=Currency.USD,
        usd_amount=Decimal(usd),
        fx_rate=Decimal(rate),
        fx_rate_type=FxRateType.MEP,
        category="Income",
        counts_toward_monotributo=True,
        created_at=created_at,
        updated_at=created_at,
    )


async def _seed(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist and commit the given aggregates through the repository."""
    async with session_factory() as session:
        repository = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repository.add(row)
        await session.commit()


class TestInsightsAggregation:
    """The reader derives the mover, recurring, savings and latest-USD facts."""

    async def test_past_month_facts_over_real_data(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN expenses across May and June, recurring expenses, inflow rows and a
              pair of USD invoices, with a reference in July (a past month)
        WHEN the June 2026 insights are read from PostgreSQL
        THEN the mover is the biggest positive month-over-month expense category,
             the recurring footprint sums the flagged rows, savings are the actual
             income minus expenses (not projected), and the latest USD invoice is
             the most recent one
        """
        # GIVEN
        rows = [
            # May 2026 — prior month for the mover delta.
            _expense(date(2026, 5, 10), "100.00", "Food"),
            _expense(date(2026, 5, 12), "400.00", "Rent"),
            # June 2026 — the requested month. Food doubled (+100%), Rent fell.
            _expense(date(2026, 6, 5), "200.00", "Food"),
            _expense(date(2026, 6, 6), "300.00", "Rent"),
            # Two recurring June expenses -> count 2, total 1500.
            _expense(date(2026, 6, 7), "500.00", "Subscriptions", recurring=True, name="Netflix"),
            _expense(date(2026, 6, 8), "1000.00", "Services", recurring=True, name="Gym"),
            # June inflow: income 5000 + invoice 3000 = 8000.
            _income(date(2026, 6, 2), "5000.00", Kind.INCOME),
            _income(date(2026, 6, 3), "3000.00", Kind.INVOICE),
            # Two USD invoices in June; the 20th is the latest.
            _usd_invoice(date(2026, 6, 15), "50.00", "1100.00", _MOMENT),
            _usd_invoice(date(2026, 6, 20), "100.00", "1200.00", _MOMENT),
        ]
        await _seed(session_factory, rows)

        # WHEN — reference in July makes June a past month: actual savings.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1))

        # THEN — month key.
        assert insights.month == "2026-06"

        # THEN — biggest positive mover: Food 100 -> 200 = +100%; Rent fell.
        assert insights.top_category_mover is not None
        assert insights.top_category_mover.category == "Food"
        assert insights.top_category_mover.delta_pct == Decimal("100")

        # THEN — recurring footprint: 2 rows summing 1500.
        assert insights.recurring is not None
        assert insights.recurring.count == 2
        assert insights.recurring.total == Decimal("1500.00")

        # THEN — savings: inflow (income + invoice kinds) minus expenses, actual.
        # Inflow = income 5000 + invoice 3000 + USD invoices (50*1100) + (100*1200) = 183000.
        # Expenses = 200 + 300 + 500 + 1000 = 2000 -> savings = 183000 - 2000 = 181000.
        assert insights.savings.is_projected is False
        assert insights.savings.elapsed_fraction == Decimal(1)
        assert insights.savings.amount == Decimal("181000.00")

        # THEN — latest USD invoice is the June 20th row.
        assert insights.latest_usd_invoice is not None
        assert insights.latest_usd_invoice.occurred_on == date(2026, 6, 20)
        assert insights.latest_usd_invoice.usd == Decimal("100.00")
        assert insights.latest_usd_invoice.rate == Decimal("1200.00")
        assert insights.latest_usd_invoice.rate_type == FxRateType.MEP.value

    async def test_current_month_savings_are_projected(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN inflow and expenses in the requested month with an explicit mid-month
              reference (the current month)
        WHEN the insights are read from PostgreSQL
        THEN savings are projected to month-end by the elapsed fraction and flagged
             projected
        """
        # GIVEN — June inflow 4000, expenses 1000 -> actual savings 3000.
        rows = [
            _income(date(2026, 6, 2), "4000.00", Kind.INCOME),
            _expense(date(2026, 6, 5), "1000.00", "Food"),
        ]
        await _seed(session_factory, rows)

        # WHEN — reference June 15th: June has 30 days -> fraction 15/30.
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 6, 15))

        # THEN — projected: 3000 / (15/30) = 6000.
        assert insights.savings.is_projected is True
        assert insights.savings.elapsed_fraction == Decimal(15) / Decimal(30)
        assert insights.savings.amount == Decimal("6000.00")

    async def test_empty_month_returns_none_facts_and_zero_savings(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a month with no transactions at all
        WHEN the insights are read from PostgreSQL
        THEN the optional facts are None and savings are 0
        """
        # WHEN — empty database, reference in a later month (actual savings).
        async with session_factory() as session:
            reader = SqlAlchemyInsightsReader(session)
            insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1))

        # THEN
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
        assert insights.savings.amount == Decimal("0")
        assert insights.savings.is_projected is False
