"""Integration tests for the reports reader against real PostgreSQL (ADR-164).

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is set
and a real PostgreSQL is reachable, and are excluded from the coverage gate. They
prove the cumulative month-END net-worth SQL — the per-currency opening totals, the
signed transaction deltas, the net transfer flow, the pre-window fold-in and the
owner scoping — actually work end to end, which the mocked fast tiers cannot verify.

The reader anchors its window at ``datetime.now(UTC)``, so movements are placed
relative to the current month (this month and last month) to stay date-robust.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.account_repository import SqlAlchemyAccountRepository
from margen_api.adapters.institution_repository import SqlAlchemyInstitutionRepository
from margen_api.adapters.reports_queries import SqlAlchemyReportsReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.transfer_repository import SqlAlchemyTransferRepository
from margen_api.domain.models.account import build_account
from margen_api.domain.models.institution import build_institution
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.transfer import build_transfer
from margen_api.domain.models.value_objects import Currency, InstitutionType, Kind
from margen_api.service_layer.net_worth_history import add_months, month_key

pytestmark = pytest.mark.integration

# Two distinct owners prove the history is scoped to the caller (ADR-131).
OWNER = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER = "22222222-2222-4222-8222-222222222222"

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _first_of_current_month() -> date:
    """Return the first day of the current calendar month (the reader's newest point)."""
    today = datetime.now(UTC).date()
    return date(today.year, today.month, 1)


class TestNetWorthHistorySql:
    """The reader accumulates opening + signed deltas + transfer flow per month per currency."""

    async def test_cumulative_across_a_month_boundary_and_transfers(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN an ARS and a USD account with opening balances, transactions last month
              and this month, and a same-currency transfer between two ARS accounts
        WHEN the net-worth history for the last 3 months is read from PostgreSQL
        THEN each month carries the cumulative native subtotal per currency, the
             same-currency transfer nets to zero, and pre-window movement folds into
             the opening cumulative (ADR-122, ADR-135, ADR-164)
        """
        # GIVEN — month anchors relative to today so the test is date-robust.
        this_month = _first_of_current_month()
        last_month = add_months(this_month, -1)
        window_start = add_months(this_month, -2)  # 3-month window: [start, last, this]
        before_window = add_months(window_start, -1)

        institution = build_institution(name="Galicia", type=InstitutionType.BANK, user_id=OWNER)
        ars = build_account(
            institution_id=institution.id, currency=Currency.ARS, opening_balance=Decimal("10000"), user_id=OWNER
        )
        ars_two = build_account(
            institution_id=institution.id, currency=Currency.ARS, opening_balance=Decimal("0"), user_id=OWNER
        )
        usd = build_account(
            institution_id=institution.id, currency=Currency.USD, opening_balance=Decimal("0"), user_id=OWNER
        )

        def _tx(account_id, occurred_on, kind, amount, *, currency=Currency.ARS, usd_amount=None):
            return build_transaction(
                transaction_id=uuid4(),
                occurred_on=occurred_on,
                name="Movement",
                kind=kind,
                amount=Decimal(amount),
                currency=currency,
                usd_amount=usd_amount,
                account_id=account_id,
                user_id=OWNER,
                created_at=_MOMENT,
                updated_at=_MOMENT,
            )

        rows = [
            # BEFORE the window: +8000 ARS — must fold into the window's first month.
            _tx(ars.id, before_window.replace(day=10), Kind.INCOME, "8000"),
            # Last month: +5000 ARS income; +50 USD income (usd snapshot native).
            _tx(ars.id, last_month.replace(day=10), Kind.INCOME, "5000"),
            _tx(
                usd.id,
                last_month.replace(day=12),
                Kind.INCOME,
                "50000",
                currency=Currency.USD,
                usd_amount=Decimal("50"),
            ),
            # This month: -2000 ARS expense.
            _tx(ars.id, this_month.replace(day=5), Kind.EXPENSE, "2000"),
        ]
        # A same-currency ARS transfer this month: nets to zero across the two ARS accounts.
        transfer = build_transfer(
            from_account_id=ars.id,
            to_account_id=ars_two.id,
            amount_out=Decimal("1000"),
            amount_in=Decimal("1000"),
            occurred_on=this_month.replace(day=6),
            user_id=OWNER,
        )

        async with session_factory() as session:
            SqlAlchemyInstitutionRepository(session).add(institution)
            await session.flush()
            for account in (ars, ars_two, usd):
                SqlAlchemyAccountRepository(session).add(account)
            await session.flush()
            transaction_repo = SqlAlchemyTransactionRepository(session)
            for row in rows:
                transaction_repo.add(row)
            SqlAlchemyTransferRepository(session).add(transfer)
            await session.commit()

        # WHEN
        async with session_factory() as session:
            reader = SqlAlchemyReportsReader(session)
            history = await reader.net_worth_history(OWNER, months=3)

        # THEN — oldest-first over the 3-month window.
        points = {point.month: point for point in history.months}
        assert [point.month for point in history.months] == [
            month_key(window_start),
            month_key(last_month),
            month_key(this_month),
        ]
        # ARS: opening 10000 + folded-in 8000 = 18000 at the window start.
        assert points[month_key(window_start)].ars_total == Decimal("18000.00")
        # Last month: +5000 => 23000. USD: +50 => 50.
        assert points[month_key(last_month)].ars_total == Decimal("23000.00")
        assert points[month_key(last_month)].usd_total == Decimal("50.00")
        # This month: -2000 expense; the 1000 transfer nets to zero across ARS accounts => 21000.
        assert points[month_key(this_month)].ars_total == Decimal("21000.00")
        assert points[month_key(this_month)].usd_total == Decimal("50.00")

    async def test_history_is_scoped_to_the_caller(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one owner's account with a balance
        WHEN a different owner (with no accounts) reads their history
        THEN it is all-zero — never the first owner's balances (ADR-131)
        """
        # GIVEN — only OWNER has an account and a movement.
        this_month = _first_of_current_month()
        institution = build_institution(name="Galicia", user_id=OWNER)
        account = build_account(
            institution_id=institution.id, currency=Currency.ARS, opening_balance=Decimal("99999"), user_id=OWNER
        )
        async with session_factory() as session:
            SqlAlchemyInstitutionRepository(session).add(institution)
            await session.flush()
            SqlAlchemyAccountRepository(session).add(account)
            await session.commit()

        # WHEN — OTHER_OWNER reads their own (empty) history.
        async with session_factory() as session:
            reader = SqlAlchemyReportsReader(session)
            history = await reader.net_worth_history(OTHER_OWNER, months=2)

        # THEN — no cross-tenant leakage.
        assert all(point.ars_total == Decimal("0") and point.usd_total == Decimal("0") for point in history.months)
        assert history.months[-1].month == month_key(this_month)


class TestOverviewSql:
    """The reader's range aggregations run against real PostgreSQL (ADR-167, ADR-168).

    Proves the ``extract(year/month)`` grouping, the currency-aware SUMs, the
    ``avg(fx_rate)`` and the ``usd_amount`` null-exclusion / unconverted count behave
    on the real dialect (SQLite cannot exercise Postgres numeric semantics). Movements
    are anchored to the current month so the newest window point reflects them.
    """

    async def test_ars_and_usd_denomination_with_unconverted(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a USD invoice with a snapshot, a USD expense with a snapshot in a
              category, and an ARS expense WITHOUT a snapshot, all this month
        WHEN the ARS and USD overviews are read from PostgreSQL
        THEN the ARS path sums amount with unconverted 0, the USD path sums the
             snapshot column, excludes and counts the snapshotless row, and the FX
             summary carries the averaged captured rate (ADR-152, ADR-168)
        """
        # GIVEN — anchor to the current month so the window includes these rows.
        this_month = _first_of_current_month()
        day = this_month.replace(day=10)

        def _tx(kind, amount, *, currency=Currency.ARS, usd_amount=None, fx_rate=None, category=None):
            return build_transaction(
                transaction_id=uuid4(),
                occurred_on=day,
                name="Movement",
                kind=kind,
                amount=Decimal(amount),
                currency=currency,
                usd_amount=usd_amount,
                fx_rate=fx_rate,
                category=category,
                user_id=OWNER,
                created_at=_MOMENT,
                updated_at=_MOMENT,
            )

        rows = [
            _tx(Kind.INVOICE, "1000000", currency=Currency.USD, usd_amount=Decimal("1000"), fx_rate=Decimal("1000")),
            _tx(
                Kind.EXPENSE,
                "200000",
                currency=Currency.USD,
                usd_amount=Decimal("200"),
                fx_rate=Decimal("1000"),
                category="Food",
            ),
            _tx(Kind.EXPENSE, "400", category="Transport"),
        ]
        async with session_factory() as session:
            repo = SqlAlchemyTransactionRepository(session)
            for row in rows:
                repo.add(row)
            await session.commit()

        # WHEN — ARS denomination.
        async with session_factory() as session:
            ars = await SqlAlchemyReportsReader(session).overview(OWNER, range_key="3M", currency=Currency.ARS)
        # ARS: income 1_000_000, expenses 200_000 + 400, unconverted 0.
        assert ars.currency == "ARS"
        assert ars.unconverted == 0
        assert ars.kpis.current.income == Decimal("1000000.00")
        assert ars.kpis.current.expenses == Decimal("200400.00")

        # WHEN — USD denomination.
        async with session_factory() as session:
            usd = await SqlAlchemyReportsReader(session).overview(OWNER, range_key="3M", currency=Currency.USD)
        # USD: income sums the 1000 snapshot; the ARS Transport expense has no snapshot
        # -> excluded from USD expenses and counted as unconverted.
        assert usd.currency == "USD"
        assert usd.kpis.current.income == Decimal("1000.00")
        assert usd.kpis.current.expenses == Decimal("200.00")
        assert usd.unconverted == 1
        food = next(trend for trend in usd.category_trends if trend.category == "Food")
        assert food.total == Decimal("200.00")
        # FX summary: the captured rate averaged across the month, and USD invoiced.
        assert usd.fx_summary.usd_invoiced == Decimal("1000.00")
        assert usd.fx_summary.avg_mep == Decimal("1000.000000")
        current_key = month_key(this_month)
        current_rate = next(point for point in usd.fx_summary.rate_series if point.month == current_key)
        assert current_rate.rate == Decimal("1000.000000")

    async def test_ytd_previous_window_and_scoping(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN one owner's income this month
        WHEN a different owner reads the YTD overview from PostgreSQL
        THEN the caller's KPIs are all zero — the first owner's rows never leak (ADR-131)
        """
        # GIVEN — only OWNER has an income this month.
        this_month = _first_of_current_month()
        income = build_transaction(
            transaction_id=uuid4(),
            occurred_on=this_month.replace(day=5),
            name="Salary",
            kind=Kind.INCOME,
            amount=Decimal("5000"),
            currency=Currency.ARS,
            user_id=OWNER,
            created_at=_MOMENT,
            updated_at=_MOMENT,
        )
        async with session_factory() as session:
            SqlAlchemyTransactionRepository(session).add(income)
            await session.commit()

        # WHEN — a different owner reads their own (empty) YTD overview.
        async with session_factory() as session:
            overview = await SqlAlchemyReportsReader(session).overview(
                OTHER_OWNER, range_key="YTD", currency=Currency.ARS
            )

        # THEN — no cross-tenant leakage.
        assert overview.range == "YTD"
        assert overview.kpis.current.income == Decimal("0.00")
        assert overview.kpis.current.expenses == Decimal("0.00")
        assert overview.category_trends == []
