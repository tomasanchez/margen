"""Integration tests for the summary reader against real PostgreSQL (ADR-042).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove the server-side ``SUM`` / ``GROUP BY`` aggregation, the kind filter,
the null-category bucket and the prior-month delta actually work end to end —
what the mocked fast tiers cannot verify.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.queries import SqlAlchemySummaryReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind

pytestmark = pytest.mark.integration

# Two distinct owners prove the summary is scoped to the caller (ADR-108).
OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"


def _expense(occurred_on: date, amount: str, category: str | None, name: str = "Spend", *, user_id: str = OWNER):
    """Build an ARS expense aggregate for a date, category and owner."""
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category=category,
        user_id=user_id,
        created_at=moment,
        updated_at=moment,
    )


def _income(occurred_on: date, amount: str, *, user_id: str = OWNER):
    """Build an income aggregate that must be excluded from expense sums."""
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Salary",
        kind=Kind.INCOME,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Income",
        user_id=user_id,
        created_at=moment,
        updated_at=moment,
    )


class TestSummaryAggregation:
    """The reader aggregates trend, shares, delta and excludes non-expenses."""

    async def test_trend_categories_delta_and_kind_filter(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN expenses across May and June plus income in June
        WHEN the summary for June 2026 is read from PostgreSQL
        THEN the trend sums by month, categories carry share and delta vs May,
             null categories bucket under 'Uncategorized', and income is excluded
        """
        # GIVEN
        rows = [
            # May 2026 — prior month for the delta.
            _expense(date(2026, 5, 10), "100.00", "Food"),
            _expense(date(2026, 5, 20), "200.00", "Rent"),
            # June 2026 — the requested month.
            _expense(date(2026, 6, 5), "300.00", "Food"),  # Food doubled vs May
            _expense(date(2026, 6, 6), "200.00", "Rent"),  # Rent unchanged vs May
            _expense(date(2026, 6, 7), "100.00", None),  # null -> Uncategorized
            _income(date(2026, 6, 8), "999999.00"),  # excluded
        ]
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            for row in rows:
                repository.add(row)
            await session.commit()

        # WHEN
        async with session_factory() as session:
            reader = SqlAlchemySummaryReader(session)
            summary = await reader.monthly_summary(date(2026, 6, 15), OWNER)

        # THEN — month and a 6-point trend ending at June.
        assert summary.month == "2026-06"
        trend = {point.month: point for point in summary.trend}
        assert [point.month for point in summary.trend] == [
            "2026-01",
            "2026-02",
            "2026-03",
            "2026-04",
            "2026-05",
            "2026-06",
        ]
        # May expenses = 300; June expenses = 300+200+100 = 600 (income excluded).
        assert trend["2026-05"].expenses == Decimal("300.00")
        assert trend["2026-06"].expenses == Decimal("600.00")
        assert trend["2026-06"].current is True
        assert trend["2026-01"].expenses == Decimal("0")

        # THEN — categories sorted by amount desc, share of 600, delta vs May.
        by_category = {c.category: c for c in summary.categories}
        assert [c.category for c in summary.categories] == ["Food", "Rent", "Uncategorized"]
        assert by_category["Food"].amount == Decimal("300.00")
        assert by_category["Food"].share == Decimal("50")
        # Food 100 -> 300 => +200%.
        assert by_category["Food"].delta_pct == Decimal("200")
        # Rent 200 -> 200 => 0%.
        assert by_category["Rent"].delta_pct == Decimal("0")
        # Uncategorized had no May presence => None.
        assert by_category["Uncategorized"].delta_pct is None

    async def test_summary_is_scoped_to_the_caller(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one owner's expenses and a different owner's expenses in the same month
        WHEN the summary for the other owner (with no spending) is read
        THEN it sees a zero trend and no categories — never the first owner's rows
             (ADR-108)
        """
        # GIVEN — only OWNER has June expenses.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            repository.add(_expense(date(2026, 6, 5), "300.00", "Food", user_id=OWNER))
            repository.add(_expense(date(2026, 6, 6), "200.00", "Rent", user_id=OWNER))
            await session.commit()

        # WHEN — OTHER_OWNER reads their own (empty) summary.
        async with session_factory() as session:
            reader = SqlAlchemySummaryReader(session)
            summary = await reader.monthly_summary(date(2026, 6, 15), OTHER_OWNER)

        # THEN — no cross-tenant leakage: zero trend, no categories.
        assert summary.categories == []
        assert all(point.expenses == Decimal("0") for point in summary.trend)
