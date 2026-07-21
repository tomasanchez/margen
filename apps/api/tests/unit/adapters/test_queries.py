"""Unit tests for the SQLAlchemy transaction reader (ADR-032).

Per ADR-032 these mock the ``AsyncSession`` and the execute result — no real
database. They assert the reader builds a newest-first ``select`` and projects
rows into read models.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

from sqlalchemy import Select

from margen_api.adapters.budget_queries import SqlAlchemyBudgetReader
from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.queries import (
    SqlAlchemyInsightsReader,
    SqlAlchemyMonotributoReader,
    SqlAlchemySettingsReader,
    SqlAlchemySummaryReader,
    SqlAlchemyTransactionReader,
)
from margen_api.adapters.settings_repository import (
    DEFAULT_DISPLAY_CURRENCY,
    DEFAULT_FX_RATE_TYPE,
    DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    DEFAULT_MONOTRIBUTO_CATEGORY,
    DEFAULT_MONOTRIBUTO_ENABLED,
)
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType

# The card-due window looks 3 days ahead inclusive of today; a fixed "today" keeps
# the window deterministic and clock-independent in these mocked-session tests.
_TODAY = date(2026, 6, 12)

A_DATE = date(2026, 6, 12)
A_TIME = datetime(2026, 6, 12, tzinfo=UTC)
A_USER = "00000000-0000-4000-8000-000000000001"


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
        models = await reader.list_transactions(A_USER)

        # THEN
        session.execute.assert_awaited_once()
        (statement,) = session.execute.call_args.args
        assert isinstance(statement, Select)
        # The ordering clause sorts by occurred_on then created_at, descending.
        compiled = str(statement).lower()
        assert "order by" in compiled
        assert "occurred_on desc" in compiled
        # The query is scoped to the owner (ADR-108).
        assert "user_id" in compiled
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
        models = await reader.list_transactions(A_USER)

        # THEN
        assert models == []


class TestGetTransaction:
    """``get_transaction`` fetches one owner-scoped row by identity and projects it (ADR-108, ADR-111)."""

    async def test_returns_read_model_when_found(self):
        """
        GIVEN a session whose owner-scoped select returns a record
        WHEN get_transaction runs
        THEN an owner-filtered Select runs and a read model is returned
        """
        # GIVEN
        record = _record(kind="expense")
        result = MagicMock()
        result.scalar_one_or_none.return_value = record
        session = AsyncMock()
        session.execute.return_value = result
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        model = await reader.get_transaction(record.id, A_USER)

        # THEN
        session.execute.assert_awaited_once()
        (statement,) = session.execute.call_args.args
        assert isinstance(statement, Select)
        assert "user_id" in str(statement).lower()
        assert model is not None
        assert model.kind is Kind.EXPENSE
        assert model.type is TxType.EXPENSE

    async def test_returns_none_when_absent_or_cross_tenant(self):
        """
        GIVEN a session whose owner-scoped select returns None
        WHEN get_transaction runs
        THEN it returns None (a foreign owner's id is not found, ADR-111)
        """
        # GIVEN
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        session = AsyncMock()
        session.execute.return_value = result
        reader = SqlAlchemyTransactionReader(session)

        # WHEN
        model = await reader.get_transaction(uuid4(), A_USER)

        # THEN
        assert model is None


def _trend_row(year: int, month: int, total: object, category: str = "Food") -> SimpleNamespace:
    """Build a fake trend gross aggregation row (year, month, category, total)."""
    return SimpleNamespace(year=year, month=month, category=category, total=total)


def _category_row(category: str, total: object) -> SimpleNamespace:
    """Build a fake category aggregation row (category, total)."""
    return SimpleNamespace(category=category, total=total)


def _result(rows: list[SimpleNamespace]) -> MagicMock:
    """Wrap rows in a fake execute result exposing ``.all()``."""
    result = MagicMock()
    result.all.return_value = rows
    return result


def _reduction_row(category: str, reduction: object) -> SimpleNamespace:
    """Build a fake reimbursement-reduction row (category, reduction)."""
    return SimpleNamespace(category=category, reduction=reduction)


def _trend_reduction_row(year: int, month: int, reduction: object, category: str = "Food") -> SimpleNamespace:
    """Build a fake trend reimbursement-reduction row (year, month, category, reduction)."""
    return SimpleNamespace(year=year, month=month, category=category, reduction=reduction)


class TestNetCategoryExpenseTotals:
    """``month_category_expense_totals`` subtracts linked reimbursements, floored at zero (ADR-160/162)."""

    async def test_ars_net_subtracts_reimbursements(self):
        """
        GIVEN a category with gross expense and a partial linked reimbursement
        WHEN month_category_expense_totals runs in ARS
        THEN the net is gross minus the reimbursement on the authoritative amount (ADR-160)
        """
        from margen_api.adapters.queries import month_category_expense_totals

        # GIVEN — Social gross 10000, a 3000 payback linked to it.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Social", Decimal("10000.00"))]),
            _result([_reduction_row("Social", Decimal("3000.00"))]),
        ]

        # WHEN
        totals = await month_category_expense_totals(session, date(2026, 6, 1), UUID(A_USER))

        # THEN — 10000 - 3000 = 7000, exact ARS subtraction.
        assert totals == {"Social": Decimal("7000.00")}

    async def test_over_refund_floors_category_at_zero(self):
        """
        GIVEN linked reimbursements that exceed the category's gross expense
        WHEN month_category_expense_totals runs
        THEN the category spend floors at zero, never negative (ADR-162)
        """
        from margen_api.adapters.queries import month_category_expense_totals

        # GIVEN — Social gross 10000, paybacks total 12000 (over-refund).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Social", Decimal("10000.00"))]),
            _result([_reduction_row("Social", Decimal("12000.00"))]),
        ]

        # WHEN
        totals = await month_category_expense_totals(session, date(2026, 6, 1), UUID(A_USER))

        # THEN — floored at zero, not -2000.
        assert totals == {"Social": Decimal("0")}

    async def test_usd_reduction_rides_expense_rate(self):
        """
        GIVEN a USD budget with a linked payback whose reduction was derived at the
              expense's captured rate (ADR-161)
        WHEN month_category_expense_totals runs in USD
        THEN the net USD equals the expense usd_amount minus the derived reduction, and
             each query excludes null-snapshot rows (ADR-152)
        """
        from margen_api.adapters.queries import month_category_expense_totals

        # GIVEN — Social USD gross 8.00, payback USD reduction 2.50 (amount / expense rate).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Social", Decimal("8.00"))]),
            _result([_reduction_row("Social", Decimal("2.50"))]),
        ]

        # WHEN
        totals = await month_category_expense_totals(session, date(2026, 6, 1), UUID(A_USER), Currency.USD)

        # THEN — 8.00 - 2.50 = 5.50 net USD.
        assert totals == {"Social": Decimal("5.50")}
        # THEN — both the gross and the reduction query exclude expenses lacking a snapshot.
        for call in session.execute.await_args_list:
            assert "usd_amount is not null" in str(call.args[0]).lower()

    async def test_reduction_for_category_with_no_other_spend_floors_at_zero(self):
        """
        GIVEN a linked payback whose expense category has no gross bucket in the map
        WHEN month_category_expense_totals runs
        THEN that category floors at zero rather than going negative (ADR-162)
        """
        from margen_api.adapters.queries import month_category_expense_totals

        # GIVEN — gross has only Food; the reduction targets Social (its expense's category).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("5000.00"))]),
            _result([_reduction_row("Social", Decimal("1000.00"))]),
        ]

        # WHEN
        totals = await month_category_expense_totals(session, date(2026, 6, 1), UUID(A_USER))

        # THEN — Food untouched; Social floored at zero.
        assert totals == {"Food": Decimal("5000.00"), "Social": Decimal("0")}

    async def test_usd_reduction_uses_proportional_form_matching_gross_exclusion(self):
        """
        GIVEN a USD reimbursement-reduction query
        WHEN month_category_reimbursement_totals runs in USD
        THEN it derives the reduction via the proportional form usd_amount * (amount / amount)
             and excludes ONLY on usd_amount (matching the gross USD side) — never adding an
             fx_rate predicate that would drop legacy null-fx_rate snapshots (ADR-161)
        """
        from margen_api.adapters.queries import month_category_reimbursement_totals

        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _result([_reduction_row("Social", Decimal("3.00"))])

        # WHEN
        await month_category_reimbursement_totals(session, date(2026, 6, 1), UUID(A_USER), Currency.USD)

        # THEN — the reduction rides usd_amount proportionally, not amount / fx_rate.
        compiled = str(session.execute.await_args_list[0].args[0]).lower()
        assert "usd_amount" in compiled
        assert "usd_amount is not null" in compiled
        # THEN — the exclusion set matches the gross side: no fx_rate divergence.
        assert "fx_rate is not null" not in compiled

    async def test_reimbursement_query_joins_offset_link_and_scopes_owner(self):
        """
        GIVEN a reimbursement reduction query
        WHEN month_category_reimbursement_totals runs
        THEN it joins on the offset link, filters kind='reimbursement' and scopes the owner
        """
        from margen_api.adapters.queries import month_category_reimbursement_totals

        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _result([_reduction_row("Social", Decimal("3000.00"))])

        # WHEN
        reductions = await month_category_reimbursement_totals(session, date(2026, 6, 1), UUID(A_USER))

        # THEN
        assert reductions == {"Social": Decimal("3000.00")}
        compiled = str(session.execute.await_args_list[0].args[0]).lower()
        assert "offsets_transaction_id" in compiled
        assert "reimbursement" in compiled
        assert "user_id" in compiled


class TestSummaryReader:
    """``monthly_summary`` runs three aggregations and assembles the summary."""

    async def test_builds_trend_categories_and_delta(self):
        """
        GIVEN a session whose three executes return trend, month and prior totals
        WHEN monthly_summary runs for June 2026
        THEN it builds the 6-point trend, category shares and the prior-month delta
        """
        # GIVEN — execute now runs 6x: each of the trend, month and prior aggregations
        # is followed by its linked-reimbursement reduction query (ADR-160). With no
        # paybacks the reduction results are empty, so the net equals the gross.
        trend = _result([_trend_row(2026, 3, Decimal("100.00")), _trend_row(2026, 6, Decimal("400.00"))])
        month_categories = _result([_category_row("Food", Decimal("300.00")), _category_row("Rent", Decimal("100.00"))])
        prior_categories = _result([_category_row("Food", Decimal("150.00"))])
        session = AsyncMock()
        session.execute.side_effect = [
            trend,
            _result([]),  # trend reimbursement reductions (none)
            month_categories,
            _result([]),  # month reimbursement reductions (none)
            prior_categories,
            _result([]),  # prior reimbursement reductions (none)
        ]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 15), A_USER)

        # THEN — six aggregation queries ran as Selects filtered to expenses.
        assert session.execute.await_count == 6
        for call in session.execute.await_args_list:
            (statement,) = call.args
            assert isinstance(statement, Select)
        compiled = str(session.execute.await_args_list[0].args[0]).lower()
        assert "sum" in compiled
        assert "group by" in compiled
        # Every aggregation is scoped to the owner (ADR-108).
        for call in session.execute.await_args_list:
            assert "user_id" in str(call.args[0]).lower()

        # THEN — the trend spans the 6 months ending at June, oldest-first.
        assert summary.month == "2026-06"
        assert [point.month for point in summary.trend] == [
            "2026-01",
            "2026-02",
            "2026-03",
            "2026-04",
            "2026-05",
            "2026-06",
        ]
        assert summary.trend[2].expenses == Decimal("100.00")
        assert summary.trend[-1].expenses == Decimal("400.00")
        assert summary.trend[-1].current is True

        # THEN — categories sort by amount desc with share and delta.
        assert [c.category for c in summary.categories] == ["Food", "Rent"]
        food, rent = summary.categories
        assert food.share == Decimal("75")
        assert rent.share == Decimal("25")
        # Food doubled vs prior (150 -> 300) => +100%; Rent had no prior => None.
        assert food.delta_pct == Decimal("100")
        assert rent.delta_pct is None

    async def test_coerces_float_sums_to_decimal(self):
        """
        GIVEN a backend (e.g. SQLite) that returns float SUMs
        WHEN monthly_summary runs
        THEN the totals are coerced to Decimal money (ADR-025)
        """
        # GIVEN
        trend = _result([_trend_row(2026, 6, 250.5)])
        month_categories = _result([_category_row("Food", 250.5)])
        prior_categories = _result([])
        session = AsyncMock()
        session.execute.side_effect = [
            trend,
            _result([]),  # trend reimbursement reductions (none)
            month_categories,
            _result([]),  # month reimbursement reductions (none)
            prior_categories,
            _result([]),  # prior reimbursement reductions (none)
        ]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 1), A_USER)

        # THEN
        assert summary.trend[-1].expenses == Decimal("250.5")
        assert summary.categories[0].amount == Decimal("250.5")

    async def test_trend_nets_reimbursements_by_linked_expense_month(self):
        """
        GIVEN a trend window with linked reimbursements attributed to an expense month
        WHEN monthly_summary runs
        THEN the trend point for that month is net of the paybacks, floored at zero (ADR-160/162)
        """
        # GIVEN — June gross 400000; a 100000 payback linked to a June expense and a
        # 999999 over-refund linked to a March expense (floors March at zero).
        trend = _result([_trend_row(2026, 3, Decimal("100000.00")), _trend_row(2026, 6, Decimal("400000.00"))])
        trend_reductions = _result(
            [_trend_reduction_row(2026, 6, Decimal("100000.00")), _trend_reduction_row(2026, 3, Decimal("999999.00"))]
        )
        session = AsyncMock()
        session.execute.side_effect = [
            trend,
            trend_reductions,
            _result([]),  # month categories
            _result([]),  # month reductions
            _result([]),  # prior categories
            _result([]),  # prior reductions
        ]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 15), A_USER)

        # THEN — June net 300000; March floored at zero (over-refund).
        assert summary.trend[-1].expenses == Decimal("300000.00")
        march = next(point for point in summary.trend if point.month == "2026-03")
        assert march.expenses == Decimal("0")

    async def test_trend_month_equals_summed_category_breakdown_on_over_refund(self):
        """
        GIVEN one month with a normal category and an over-refunded sibling category
        WHEN monthly_summary runs
        THEN the trend point for that month EQUALS the summed category breakdown for the
             same month — the trend floors per CATEGORY, not per month, so an over-refund
             in one category never swallows a sibling's real spend (ADR-160/162)
        """
        # GIVEN — June: category A gross 100 (no payback); category B gross 50 with a
        # 200 over-refund. Per-category floor => A=100, B=max(50-200,0)=0, month total 100.
        # A per-MONTH floor would instead read max((100+50)-200, 0) = 0 and swallow A's
        # real 100 of spend — the bug this test pins.
        trend = _result([_trend_row(2026, 6, Decimal("100.00"), "A"), _trend_row(2026, 6, Decimal("50.00"), "B")])
        trend_reductions = _result([_trend_reduction_row(2026, 6, Decimal("200.00"), "B")])
        month_categories = _result([_category_row("A", Decimal("100.00")), _category_row("B", Decimal("50.00"))])
        month_reductions = _result([_reduction_row("B", Decimal("200.00"))])
        session = AsyncMock()
        session.execute.side_effect = [
            trend,
            trend_reductions,
            month_categories,
            month_reductions,
            _result([]),  # prior categories
            _result([]),  # prior reductions
        ]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 15), A_USER)

        # THEN — the invariant: trend month value == sum of the category breakdown.
        june_trend = next(point for point in summary.trend if point.month == "2026-06")
        category_breakdown_total = sum((c.amount for c in summary.categories), Decimal("0"))
        assert june_trend.expenses == category_breakdown_total
        # THEN — both read 100: A's real spend survives, B floors at zero (ADR-162).
        assert june_trend.expenses == Decimal("100.00")
        assert category_breakdown_total == Decimal("100.00")


def _recurring_row(count: int, total: object) -> MagicMock:
    """Wrap a recurring (count, total) row in a fake result exposing ``one``."""
    result = MagicMock()
    result.one.return_value = SimpleNamespace(recurring_count=count, recurring_total=total)
    return result


def _usd_record(
    occurred_on: date,
    usd: str,
    rate: str | None,
    *,
    fx_rate_type: str | None = "MEP",
) -> TransactionRecord:
    """Build a USD transaction record for the latest-USD-invoice projection."""
    record = TransactionRecord()
    record.id = uuid4()
    record.occurred_on = occurred_on
    record.name = "USD invoice"
    record.kind = "invoice"
    record.amount = Decimal("120000")
    record.currency = "USD"
    record.usd_amount = Decimal(usd)
    record.fx_rate = Decimal(rate) if rate is not None else None
    record.fx_rate_type = fx_rate_type
    return record


def _card_due_row(due_date: date, currency: str, total: object) -> SimpleNamespace:
    """Build a fake upcoming-card-due aggregation row (due_date, currency, total)."""
    return SimpleNamespace(due_date=due_date, currency=currency, total=total)


class TestInsightsReader:
    """``monthly_insights`` runs six aggregations and assembles the facts (ADR-061)."""

    async def test_assembles_all_facts(self):
        """
        GIVEN a session whose six executes return month/prior categories, recurring,
              inflow, expense and a latest USD invoice
        WHEN monthly_insights runs for a past month
        THEN it picks the mover, sums recurring, computes actual savings and projects
             the latest USD invoice
        """
        # GIVEN — execute sequence now nets each expense aggregation against linked
        # reimbursements (ADR-160) and adds the over-refund-excess probe to the inflow
        # (ADR-162). With no paybacks the reductions are empty, so the facts are
        # unchanged. Order: month cats(gross,reduction), prior cats(gross,reduction),
        # recurring, inflow scalar, over-refund(gross,reduction), expense net(gross,
        # reduction), latest USD.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("300.00")), _category_row("Rent", Decimal("100.00"))]),
            _result([]),  # month reimbursement reductions (none)
            _result([_category_row("Food", Decimal("150.00"))]),
            _result([]),  # prior reimbursement reductions (none)
            _recurring_row(2, Decimal("900.00")),
            _scalar_result(Decimal("3000.00")),  # inflow (income + invoice)
            _result([]),  # over-refund excess: gross expense (empty)
            _result([]),  # over-refund excess: reimbursement reductions (none)
            _result([_category_row("Food", Decimal("300.00")), _category_row("Rent", Decimal("100.00"))]),
            _result([]),  # expense-total net: reimbursement reductions (none)
            _scalar_result(_usd_record(date(2026, 6, 20), "100.00", "1200.00")),
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — reference in July makes June a past month: actual savings.
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN — twelve aggregation queries ran as Selects, each scoped to the owner (ADR-108).
        assert session.execute.await_count == 12
        for call in session.execute.await_args_list:
            (statement,) = call.args
            assert isinstance(statement, Select)
            assert "user_id" in str(statement).lower()

        # THEN — facts.
        assert insights.month == "2026-06"
        assert insights.top_category_mover is not None
        assert insights.top_category_mover.category == "Food"
        assert insights.top_category_mover.delta_pct == Decimal("100")
        assert insights.recurring is not None
        assert insights.recurring.count == 2
        assert insights.recurring.total == Decimal("900.00")
        # Savings actual = inflow 3000 - expense 400 = 2600.
        assert insights.savings.is_projected is False
        assert insights.savings.amount == Decimal("2600.00")
        assert insights.latest_usd_invoice is not None
        assert insights.latest_usd_invoice.usd == Decimal("100.00")
        assert insights.latest_usd_invoice.rate == Decimal("1200.00")
        assert insights.latest_usd_invoice.rate_type == "MEP"
        assert insights.latest_usd_invoice.occurred_on == date(2026, 6, 20)

    async def test_over_refund_excess_credits_income(self):
        """
        GIVEN a category whose linked paybacks exceed its gross expense (over-refund)
        WHEN monthly_insights runs
        THEN the excess is added to the month's income and the net expense floors at zero,
             so savings reflect the excess-to-income routing (ADR-162)
        """
        # GIVEN — inflow (income) 100000; Social gross 5000 with 8000 of paybacks =>
        # excess 3000 credited to income; net expense floors at zero.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Social", Decimal("5000.00"))]),  # month cats gross
            _result([_reduction_row("Social", Decimal("8000.00"))]),  # month reductions (over-refund)
            _result([]),  # prior cats gross
            _result([]),  # prior reductions
            _recurring_row(0, Decimal("0")),
            _scalar_result(Decimal("100000.00")),  # ordinary income inflow
            _result([_category_row("Social", Decimal("5000.00"))]),  # over-refund excess: gross
            _result([_reduction_row("Social", Decimal("8000.00"))]),  # over-refund excess: reductions
            _result([_category_row("Social", Decimal("5000.00"))]),  # expense-total net: gross
            _result([_reduction_row("Social", Decimal("8000.00"))]),  # expense-total net: reductions
            _scalar_result(None),  # latest USD
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — past month => actual savings.
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN — income = 100000 + 3000 excess; net expense = 0; savings = 103000.
        assert insights.savings.is_projected is False
        assert insights.savings.amount == Decimal("103000.00")

    async def test_partial_payback_adds_no_income_excess(self):
        """
        GIVEN a category whose linked paybacks are LESS than its gross expense
        WHEN monthly_insights runs
        THEN no over-refund excess is credited to income (the excess is zero, ADR-162)
             and savings reflect only the net expense reduction
        """
        # GIVEN — inflow 100000; Social gross 10000 with only 3000 of paybacks (no
        # over-refund) => excess 0; net expense 7000.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Social", Decimal("10000.00"))]),  # month cats gross
            _result([_reduction_row("Social", Decimal("3000.00"))]),  # month reductions (partial)
            _result([]),  # prior cats gross
            _result([]),  # prior reductions
            _recurring_row(0, Decimal("0")),
            _scalar_result(Decimal("100000.00")),  # ordinary income inflow
            _result([_category_row("Social", Decimal("10000.00"))]),  # over-refund excess: gross
            _result([_reduction_row("Social", Decimal("3000.00"))]),  # over-refund excess: reductions
            _result([_category_row("Social", Decimal("10000.00"))]),  # expense-total net: gross
            _result([_reduction_row("Social", Decimal("3000.00"))]),  # expense-total net: reductions
            _scalar_result(None),  # latest USD
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — past month => actual savings.
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN — income stays 100000 (no excess); net expense 7000; savings = 93000.
        assert insights.savings.amount == Decimal("93000.00")

    async def test_empty_month_has_none_facts_and_zero_savings(self):
        """
        GIVEN a session whose executes all return empty / None aggregates
        WHEN monthly_insights runs
        THEN the optional facts are None and savings are 0
        """
        # GIVEN — execute sequence with no data anywhere (each expense aggregation is
        # followed by an empty reimbursement-reduction result; ADR-160/162).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),  # month categories (gross)
            _result([]),  # month reimbursement reductions
            _result([]),  # prior categories (gross)
            _result([]),  # prior reimbursement reductions
            _recurring_row(0, Decimal("0")),  # no recurring
            _scalar_result(None),  # no inflow -> 0
            _result([]),  # over-refund excess: gross expense
            _result([]),  # over-refund excess: reimbursement reductions
            _result([]),  # expense-total net: gross expense
            _result([]),  # expense-total net: reimbursement reductions
            _scalar_result(None),  # no latest USD invoice
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
        assert insights.upcoming_card_due is None
        assert insights.savings.amount == Decimal("0")

    async def test_latest_usd_invoice_defaults_rate_type_when_missing(self):
        """
        GIVEN a USD invoice row carrying no ``fx_rate_type``
        WHEN monthly_insights runs
        THEN the latest USD invoice falls back to the documented MEP rate type
        """
        # GIVEN
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),  # month categories (gross)
            _result([]),  # month reimbursement reductions
            _result([]),  # prior categories (gross)
            _result([]),  # prior reimbursement reductions
            _recurring_row(0, Decimal("0")),
            _scalar_result(None),  # inflow
            _result([]),  # over-refund excess: gross
            _result([]),  # over-refund excess: reductions
            _result([]),  # expense-total net: gross
            _result([]),  # expense-total net: reductions
            _scalar_result(_usd_record(date(2026, 6, 9), "50.00", "1100.00", fx_rate_type=None)),
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN
        assert insights.latest_usd_invoice is not None
        assert insights.latest_usd_invoice.rate_type == FxRateType.MEP.value

    async def test_january_prior_month_rolls_back_a_year(self):
        """
        GIVEN a requested month of January
        WHEN monthly_insights runs
        THEN the prior-category query targets the previous December (year - 1)
        """
        # GIVEN — eleven no-data executes; we only assert the prior bound rolled back.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),  # month categories (gross)
            _result([]),  # month reimbursement reductions
            _result([]),  # prior categories (gross)
            _result([]),  # prior reimbursement reductions
            _recurring_row(0, Decimal("0")),
            _scalar_result(None),  # inflow
            _result([]),  # over-refund excess: gross
            _result([]),  # over-refund excess: reductions
            _result([]),  # expense-total net: gross
            _result([]),  # expense-total net: reductions
            _scalar_result(None),  # latest USD
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 1, 1), date(2026, 2, 1), A_USER)

        # THEN — no crash on the year rollover and the requested month is January.
        assert insights.month == "2026-01"
        assert session.execute.await_count == 12

    async def test_coerces_float_sums_to_decimal(self):
        """
        GIVEN a backend (e.g. SQLite) returning float SUMs
        WHEN monthly_insights runs
        THEN the recurring total and savings totals are coerced to Decimal (ADR-025)
        """
        # GIVEN
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),  # month categories (gross)
            _result([]),  # month reimbursement reductions
            _result([]),  # prior categories (gross)
            _result([]),  # prior reimbursement reductions
            _recurring_row(1, 250.5),  # float total
            _scalar_result(1000.5),  # float inflow
            _result([]),  # over-refund excess: gross
            _result([]),  # over-refund excess: reductions
            _result([_category_row("Food", 250.25)]),  # expense-total net gross (float)
            _result([]),  # expense-total net: reductions
            _scalar_result(None),
            _result([]),  # upcoming card due (none)
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN
        assert insights.recurring is not None
        assert insights.recurring.total == Decimal("250.5")
        assert insights.savings.amount == Decimal("1000.5") - Decimal("250.25")


class TestUpcomingCardDue:
    """``_upcoming_card_due`` groups near-term CARD-account charges by date + currency (ADR-089)."""

    async def test_builds_windowed_card_type_expense_select(self):
        """
        GIVEN a session whose card-due query returns no rows
        WHEN _upcoming_card_due runs
        THEN it builds a Select joined to CARD-type institutions, filtered to expenses in
             the inclusive [today, today+3] window, grouped by date + currency and scoped
             to the owner (ADR-089, ADR-108)
        """
        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _result([])
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — a fixed today keeps the window deterministic.
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN — no rows -> empty list; and the SQL carries the full derivation contract.
        assert dues == []
        (statement,) = session.execute.await_args.args
        assert isinstance(statement, Select)
        compiled = str(statement).lower()
        assert "sum" in compiled
        assert "group by" in compiled
        assert "order by" in compiled
        # CARD-type join + expense filter + owner scope (ADR-089, ADR-108).
        assert "institution" in compiled
        assert "user_id" in compiled

    async def test_query_carries_no_installment_exclusion(self):
        """
        GIVEN the compiled card-due query
        WHEN its predicate set is inspected
        THEN it carries NO instalment-cadence filter — no ``is_distinct_from`` and no
             ``'installment'`` literal — so a due cuota is counted, keeping the alert
             INCLUSIVE of instalments UNLIKE the ccBalance liability (ADR-192). Re-adding
             the exclusion (understating the alert) fails this lock.
        """
        # GIVEN — a query that returns no rows; only the SQL text matters here.
        session = AsyncMock()
        session.execute.return_value = _result([])
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — a fixed today keeps the compiled bounds deterministic.
        await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN — the compiled predicate excludes no instalment cadence (ADR-192).
        (statement,) = session.execute.await_args.args
        compiled = str(statement.compile(compile_kwargs={"literal_binds": True})).lower()
        assert "is_distinct_from" not in compiled
        assert "installment" not in compiled
        assert "recurring_cadence" not in compiled

    async def test_charge_due_today_is_included(self):
        """
        GIVEN a card charge dated exactly today
        WHEN _upcoming_card_due runs
        THEN it is in the window (the window includes today) and surfaces as a due
        """
        # GIVEN — one ARS charge dated today.
        session = AsyncMock()
        session.execute.return_value = _result([_card_due_row(_TODAY, "ARS", Decimal("50000.00"))])
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN
        assert len(dues) == 1
        assert dues[0].due_date == _TODAY
        assert dues[0].ars == Decimal("50000.00")
        assert dues[0].usd == Decimal("0")

    async def test_charge_due_in_two_days_is_included(self):
        """
        GIVEN a card charge dated two days ahead (inside the 3-day window)
        WHEN _upcoming_card_due runs
        THEN it surfaces as a due
        """
        # GIVEN
        due = _TODAY + timedelta(days=2)
        session = AsyncMock()
        session.execute.return_value = _result([_card_due_row(due, "ARS", Decimal("12000.00"))])
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN
        assert [d.due_date for d in dues] == [due]

    async def test_window_upper_bound_is_today_plus_horizon_inclusive(self):
        """
        GIVEN the default 3-day horizon
        WHEN _upcoming_card_due runs
        THEN the query's upper bound is today+3 inclusive, so a charge 5 days out (which the
             DB would filter) is excluded by the window — proven via the bound the reader binds
        """
        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _result([])
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN — the compiled SQL binds today and today+3 (the inclusive window; a 5-day-out
        # charge falls outside it and never returns).
        compiled = str(session.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
        assert str(_TODAY) in compiled
        assert str(_TODAY + timedelta(days=3)) in compiled
        assert str(_TODAY + timedelta(days=5)) not in compiled

    async def test_ars_and_usd_on_same_date_fold_into_one_due(self):
        """
        GIVEN ARS and USD card charges dated on the SAME due date
        WHEN _upcoming_card_due runs
        THEN the two per-currency groups fold into one due carrying both native totals,
             never summed across currencies (ADR-183)
        """
        # GIVEN — same date, one ARS group and one USD group.
        due = _TODAY + timedelta(days=1)
        session = AsyncMock()
        session.execute.return_value = _result(
            [
                _card_due_row(due, "ARS", Decimal("80000.00")),
                _card_due_row(due, "USD", Decimal("150.00")),
            ]
        )
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN — one entry for the date, both native amounts present.
        assert len(dues) == 1
        assert dues[0].due_date == due
        assert dues[0].ars == Decimal("80000.00")
        assert dues[0].usd == Decimal("150.00")

    async def test_multiple_due_dates_are_ordered_ascending(self):
        """
        GIVEN card charges on several distinct due dates returned out of order
        WHEN _upcoming_card_due runs
        THEN the dues come back ordered by date ascending
        """
        # GIVEN — three dates, deliberately unsorted in the result rows.
        d1 = _TODAY
        d2 = _TODAY + timedelta(days=1)
        d3 = _TODAY + timedelta(days=3)
        session = AsyncMock()
        session.execute.return_value = _result(
            [
                _card_due_row(d3, "ARS", Decimal("300.00")),
                _card_due_row(d1, "ARS", Decimal("100.00")),
                _card_due_row(d2, "ARS", Decimal("200.00")),
            ]
        )
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN
        assert [d.due_date for d in dues] == [d1, d2, d3]

    async def test_usd_charge_sums_native_usd_amount(self):
        """
        GIVEN a USD card charge
        WHEN _upcoming_card_due runs
        THEN the USD total is the native usd_amount magnitude, kept USD-authoritative (ADR-123)
             and the query coalesces usd_amount over amount
        """
        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _result([_card_due_row(_TODAY, "USD", 99.5)])  # float from SQLite
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        dues = await reader._upcoming_card_due(UUID(A_USER), _TODAY)

        # THEN — coerced to Decimal money (ADR-025) and carried on the usd leg.
        assert dues[0].usd == Decimal("99.5")
        assert dues[0].ars == Decimal("0")
        compiled = str(session.execute.await_args.args[0]).lower()
        assert "coalesce" in compiled
        assert "usd_amount" in compiled


def _config_row(category: str = "A", activity: str = "services") -> SimpleNamespace:
    """Build a fake configured-category row from ``app_settings`` (ADR-054)."""
    return SimpleNamespace(monotributo_current_category=category, monotributo_activity_type=activity)


def _scalar_result(value: object) -> MagicMock:
    """Wrap a value in a fake result exposing ``scalar_one_or_none``."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _first_result(row: object) -> MagicMock:
    """Wrap a row in a fake result exposing ``first``."""
    result = MagicMock()
    result.first.return_value = row
    return result


def _scalars_result(rows: list[object]) -> MagicMock:
    """Wrap rows in a fake result exposing ``scalars().all``."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    return result


def _invoice_record(occurred_on: date, amount: str, currency: str = "ARS") -> TransactionRecord:
    """Build an invoice record for the drilldown projection."""
    record = TransactionRecord()
    record.id = uuid4()
    record.occurred_on = occurred_on
    record.name = "Invoice"
    record.kind = "invoice"
    record.amount = Decimal(amount)
    record.currency = currency
    record.category = "Consulting"
    return record


def _snapshot_record(period_end: date) -> MonotributoSnapshotRecord:
    """Build a persisted snapshot row for the prior-window lookup."""
    record = MonotributoSnapshotRecord()
    record.period_start = date(2024, 6, 1)
    record.period_end = period_end
    record.category = "B"
    record.activity_type = "services"
    record.limit_amount = Decimal("13175201.52")
    record.used = Decimal("700000.00")
    record.remaining = Decimal("12475201.52")
    record.percent_used = Decimal("5.31")
    record.status = "safe"
    record.projected_category = "A"
    return record


def _median_expense_results(
    monthly_totals: list[str],
    first_expense: date | None = date(2000, 1, 1),
) -> list[MagicMock]:
    """Build the execute results for the trailing-3-month median-expenses queries (ADR-200).

    The recommendation first runs ``_first_expense_month`` (a scalar MIN) so it can drop
    pre-history months, then for each IN-RANGE month runs ``month_category_expense_totals``
    = a gross-category query then a (here always empty) reimbursement query. Only the
    ``monthly_totals`` passed are in-range, mirroring the reader dropping earlier months;
    ``first_expense`` is the MIN(occurred_on) the scalar returns (``None`` = no expense
    history at all -> no per-month queries run). A ``"0"`` month yields no gross rows so it
    contributes a genuine zero to the median — a zero month inside the active range.
    """
    results: list[MagicMock] = [_scalar_result(first_expense)]  # _first_expense_month MIN
    if first_expense is None:
        return results
    for total in monthly_totals:
        gross = [] if total == "0" else [_category_row("Services", Decimal(total))]
        results.append(_result(gross))  # gross expense totals
        results.append(_result([]))  # no linked reimbursements
    return results


class TestMonotributoReader:
    """``SqlAlchemyMonotributoReader`` aggregates the standing, drilldown and previous."""

    async def test_snapshot_with_persisted_previous(self):
        """
        GIVEN a configured category, a window SUM, an invoice and a persisted prior snapshot
        WHEN the snapshot is assembled
        THEN current is computed live, the drilldown carries a cumulative, and previous
             reads the frozen persisted snapshot
        """
        # GIVEN — execute sequence: config, used(current), median-expenses (first-expense
        # MIN then 3 months, each a [gross, reimbursement] pair), invoices, snapshot_at(prior).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A")),
            _scalar_result(Decimal("1500000.50")),
            *_median_expense_results(["200000.00", "200000.00", "200000.00"]),
            _scalars_result([_invoice_record(date(2026, 1, 15), "1500000.50")]),
            _scalar_result(_snapshot_record(date(2025, 6, 1))),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — every owner-scoped query carries the user_id predicate (ADR-108).
        for call in session.execute.await_args_list:
            assert "user_id" in str(call.args[0]).lower()
        assert snapshot.current.category == "A"
        assert snapshot.current.used == Decimal("1500000.50")
        assert [entry.letter for entry in snapshot.scale] == list("ABCDEFGHIJK")
        assert snapshot.invoices[0].cumulative == Decimal("1500000.50")
        assert snapshot.invoices[0].is_foreign_currency is False
        # The current standing carries the trailing-3-month recommendation: avg 200000/mo,
        # needed 2.4M -> the cheapest band covering it (A, ceiling ~10.3M).
        assert snapshot.current.recommendation is not None
        assert snapshot.current.recommendation.typical_monthly_expenses == Decimal("200000.00")
        assert snapshot.current.recommendation.needed_annual_invoicing == Decimal("2400000.00")
        assert snapshot.current.recommendation.category == "A"
        assert snapshot.current.recommendation.above_scale is False
        assert snapshot.current.recommendation.baseline_months == 3
        # previous resolved from the persisted snapshot (note labels it a saved snapshot).
        assert snapshot.previous is not None
        assert snapshot.previous.category == "B"
        assert snapshot.previous.projection_note == "Saved snapshot from this period."
        # The recommendation rides only the live current standing, never the comparison.
        assert snapshot.previous.recommendation is None

    async def test_snapshot_computes_previous_live_when_absent(self):
        """
        GIVEN no persisted prior snapshot and no app_settings row
        WHEN the snapshot is assembled
        THEN current and previous both use the settings default category (ADR-054)
             and previous is computed live
        """
        # GIVEN — execute sequence: config(None), used(current), median-expenses
        # (first-expense MIN None -> no expense history), invoices(none), snapshot_at(None),
        # config(None) again, used(prior).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(None),  # no app_settings -> settings defaults
            _scalar_result(None),  # no current income -> 0
            *_median_expense_results([], first_expense=None),  # no expense history -> recommendation None
            _scalars_result([]),  # no invoices
            _scalar_result(None),  # no persisted prior snapshot
            _first_result(None),  # no app_settings (prior) -> settings defaults
            _scalar_result(Decimal("300000.00")),  # prior used
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — the documented settings default category (C) applies, zero current, live previous.
        assert snapshot.current.category == "C"
        assert snapshot.current.activity_type == "services"
        assert snapshot.current.used == Decimal("0")
        # No expense history -> the recommendation is null (the calm "add expenses" note).
        assert snapshot.current.recommendation is None
        assert snapshot.invoices == []
        assert snapshot.previous is not None
        assert snapshot.previous.used == Decimal("300000.00")
        assert snapshot.previous.projection_note != "Saved snapshot from this period."

    async def test_recommendation_medians_window_net_of_reimbursements(self):
        """
        GIVEN three trailing months of gross expense with a linked reimbursement in one
        WHEN the snapshot is assembled
        THEN typicalMonthlyExpenses is the MEDIAN of the NET (reimbursement-subtracted)
             month totals, and each avg query is owner-scoped (ADR-158/108/200)
        """
        # GIVEN — three months: 300k gross with a 90k payback (net 210k), 300k, 300k.
        # Net totals sorted [210k, 300k, 300k]; median (middle) = 300k.
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            _scalar_result(date(2000, 1, 1)),  # _first_expense_month -> all 3 months in-range
            _result([_category_row("Services", Decimal("300000.00"))]),
            _result([_reduction_row("Services", Decimal("90000.00"))]),
            _result([_category_row("Services", Decimal("300000.00"))]),
            _result([]),
            _result([_category_row("Services", Decimal("300000.00"))]),
            _result([]),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — median net = 300000/mo (spike-robust); every avg query is owner-scoped.
        assert snapshot.current.recommendation is not None
        assert snapshot.current.recommendation.typical_monthly_expenses == Decimal("300000.00")
        assert snapshot.current.recommendation.needed_annual_invoicing == Decimal("3600000.00")
        assert snapshot.current.recommendation.baseline_months == 3
        for call in session.execute.await_args_list:
            assert "user_id" in str(call.args[0]).lower()

    async def test_recommendation_median_ignores_single_spike_month(self):
        """
        GIVEN three trailing months where one is a huge one-off purchase
        WHEN the snapshot is assembled
        THEN typicalMonthlyExpenses is the middle month, NOT the spike-inflated mean, so
             the recommendation lands on the LOWER band the mean would have overshot (ADR-200)
        """
        # GIVEN — [800k, 850k, 5,000k]; the ~2.22M mean -> needed ~26.6M (band D); the
        # 850k median -> needed 10.2M, covered by A. The spike must not push a costlier band.
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["800000.00", "5000000.00", "850000.00"]),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — median 850k -> needed 10.2M -> band A (spike ignored), 3-month baseline.
        recommendation = snapshot.current.recommendation
        assert recommendation is not None
        assert recommendation.typical_monthly_expenses == Decimal("850000.00")
        assert recommendation.needed_annual_invoicing == Decimal("10200000.00")
        assert recommendation.category == "A"
        assert recommendation.baseline_months == 3

    async def test_recommendation_uses_two_in_range_months(self):
        """
        GIVEN only the two most recent trailing months are within the owner's data range
        WHEN the snapshot is assembled
        THEN the median is over those two months and baselineMonths reports 2 (ADR-200)
        """
        # GIVEN — reference 2026-06-14 -> trailing 2026-03/04/05; first expense 2026-04-01
        # drops March. In-range months [900k, 700k] -> median (mean of two) = 800k.
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["900000.00", "700000.00"], first_expense=date(2026, 4, 1)),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — pre-history March is dropped (not a phantom zero); median of two = 800k.
        recommendation = snapshot.current.recommendation
        assert recommendation is not None
        assert recommendation.typical_monthly_expenses == Decimal("800000.00")
        assert recommendation.baseline_months == 2

    async def test_recommendation_uses_single_in_range_month(self):
        """
        GIVEN only the most recent trailing month is within the owner's data range
        WHEN the snapshot is assembled
        THEN the median is that one month and baselineMonths reports 1 (ADR-200)
        """
        # GIVEN — first expense 2026-05-01 drops March + April; only 2026-05 (650k) in range.
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["650000.00"], first_expense=date(2026, 5, 1)),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — single in-range month; median is that month, low-confidence baseline of 1.
        recommendation = snapshot.current.recommendation
        assert recommendation is not None
        assert recommendation.typical_monthly_expenses == Decimal("650000.00")
        assert recommendation.baseline_months == 1

    async def test_recommendation_does_not_count_prehistory_as_zero(self):
        """
        GIVEN two in-range months but a first-expense month INSIDE the trailing window
        WHEN the snapshot is assembled
        THEN the median is over the two real months, NOT median([0, x, y]) that a phantom
             pre-history zero would produce — the zero would wrongly deflate it (ADR-200)
        """
        # GIVEN — trailing 2026-03/04/05, first expense 2026-04-01 drops March. Real months
        # [1,000k, 1,000k] -> median 1,000k. Had March been counted as 0, sorted [0, 1M, 1M]
        # median would be 1M too here — so pick uneven months to prove the difference:
        # in-range [600k, 1,000k] -> median (mean) 800k; phantom [0, 600k, 1,000k] -> 600k.
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["600000.00", "1000000.00"], first_expense=date(2026, 4, 1)),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — median of the two real months (800k), not the deflated 600k a phantom
        # pre-history zero would have produced.
        recommendation = snapshot.current.recommendation
        assert recommendation is not None
        assert recommendation.typical_monthly_expenses == Decimal("800000.00")
        assert recommendation.baseline_months == 2

    async def test_recommendation_flags_above_scale(self):
        """
        GIVEN trailing expenses so high the annualized need exceeds the top ceiling
        WHEN the snapshot is assembled
        THEN the recommendation lands on the top band (K) and flags aboveScale (régimen general)
        """
        # GIVEN — 10M/mo -> needed 120M > K ceiling (~108.36M for 2026-02).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["10000000.00", "10000000.00", "10000000.00"]),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="A", activity="services")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — top band as a floor, flagged beyond Monotributo.
        assert snapshot.current.recommendation is not None
        assert snapshot.current.recommendation.category == "K"
        assert snapshot.current.recommendation.above_scale is True

    async def test_recommendation_uses_goods_cuota_for_bienes(self):
        """
        GIVEN a goods (bienes) taxpayer with trailing expenses landing in category C
        WHEN the snapshot is assembled
        THEN the recommendation's monthlyFee is category C's cuotaBienes, not cuotaServicios
        """
        # GIVEN — 1.5M/mo -> needed 18M, covered by C (ceiling ~21.1M for 2026-02).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="C", activity="bienes")),
            _scalar_result(Decimal("0")),
            *_median_expense_results(["1500000.00", "1500000.00", "1500000.00"]),
            _scalars_result([]),
            _scalar_result(None),
            _first_result(_config_row(category="C", activity="bienes")),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(reference, A_USER)

        # THEN — the goods cuota applies for a bienes taxpayer.
        recommendation = snapshot.current.recommendation
        assert recommendation is not None
        assert recommendation.category == "C"
        assert recommendation.monthly_fee == get_category("C", as_of=reference).cuota_bienes

    async def test_foreign_currency_invoice_flagged(self):
        """
        GIVEN a USD invoice in the window
        WHEN current_standing then the drilldown are read
        THEN the row is flagged as foreign currency
        """
        # GIVEN — snapshot path: config, used, median-expenses (3 zero months in-range),
        # invoices(USD), snapshot_at(None), config, used.
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row()),
            _scalar_result(Decimal("1000.00")),
            *_median_expense_results(["0", "0", "0"]),
            _scalars_result([_invoice_record(date(2026, 2, 1), "1000.00", currency="USD")]),
            _scalar_result(None),
            _first_result(_config_row()),
            _scalar_result(Decimal("0")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        snapshot = await reader.snapshot(date(2026, 6, 14), A_USER)

        # THEN
        assert snapshot.invoices[0].is_foreign_currency is True

    async def test_current_standing_reads_configured_category(self):
        """
        GIVEN a persisted config row of category H
        WHEN the live current standing is computed
        THEN it uses the configured category's ceiling
        """
        # GIVEN — current_standing: config, used.
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="H")),
            _scalar_result(Decimal("5000000.00")),
        ]
        reader = SqlAlchemyMonotributoReader(session)

        # WHEN
        standing = await reader.current_standing(date(2026, 6, 14), A_USER)

        # THEN
        assert standing.category == "H"
        assert standing.used == Decimal("5000000.00")


def _settings_record(
    *,
    currency: str = "USD",
    fx: str = "official",
    category: str = "F",
    activity: str = "bienes",
    enabled: bool = True,
) -> AppSettingsRecord:
    """Build a persisted app_settings row for the reader projection."""
    record = AppSettingsRecord()
    record.preferred_display_currency = currency
    record.fx_default_rate_type = fx
    record.monotributo_current_category = category
    record.monotributo_activity_type = activity
    record.monotributo_enabled = enabled
    return record


class TestSettingsReader:
    """``SqlAlchemySettingsReader`` projects the single app_settings row (ADR-054)."""

    async def test_projects_persisted_row(self):
        """
        GIVEN a persisted app_settings row
        WHEN the settings are read
        THEN the four fields are projected into the read model
        """
        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _scalar_result(_settings_record())
        reader = SqlAlchemySettingsReader(session)

        # WHEN
        settings = await reader.get_settings(A_USER)

        # THEN — the four fields project AND the read is scoped to the owner (ADR-110).
        assert settings.preferred_display_currency == "USD"
        assert settings.fx_default_rate_type == "official"
        assert settings.monotributo_current_category == "F"
        assert settings.monotributo_activity_type == "bienes"
        assert settings.monotributo_enabled is True
        assert "user_id" in str(session.execute.call_args.args[0]).lower()

    async def test_returns_documented_defaults_when_absent(self):
        """
        GIVEN no app_settings row yet
        WHEN the settings are read
        THEN the documented defaults are returned so the query side never yields None
        """
        # GIVEN
        session = AsyncMock()
        session.execute.return_value = _scalar_result(None)
        reader = SqlAlchemySettingsReader(session)

        # WHEN
        settings = await reader.get_settings(A_USER)

        # THEN
        assert settings.preferred_display_currency == DEFAULT_DISPLAY_CURRENCY
        assert settings.fx_default_rate_type == DEFAULT_FX_RATE_TYPE
        assert settings.monotributo_current_category == DEFAULT_MONOTRIBUTO_CATEGORY
        assert settings.monotributo_activity_type == DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
        assert settings.monotributo_enabled == DEFAULT_MONOTRIBUTO_ENABLED


class TestBudgetCategoryHistory:
    """``category_history`` aggregates the three months before the requested one (ADR-145)."""

    async def test_aggregates_three_prior_months_scoped_to_owner(self):
        """
        GIVEN a session whose three executes return the 2026-03/-04/-05 category totals
        WHEN category_history runs for June 2026
        THEN avg3mo is the mean across the three months, lastMonth is May's spend, and
             every aggregation query is scoped to the owner (ADR-108)
        """
        # GIVEN — execute called 6x, oldest-first: each month's gross expense aggregation
        # is followed by its (empty) reimbursement-reduction query (ADR-160).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("30000.00"))]),
            _result([]),  # March reductions (none)
            _result([_category_row("Food", Decimal("60000.00"))]),
            _result([]),  # April reductions (none)
            _result([_category_row("Food", Decimal("90000.00")), _category_row("Transport", Decimal("9000.00"))]),
            _result([]),  # May reductions (none)
        ]
        reader = SqlAlchemyBudgetReader(session)

        # WHEN
        history = await reader.category_history(date(2026, 6, 15), A_USER)

        # THEN — six owner-scoped expense aggregations ran as Selects (ADR-108).
        assert session.execute.await_count == 6
        for call in session.execute.await_args_list:
            (statement,) = call.args
            assert isinstance(statement, Select)
            assert "user_id" in str(statement).lower()

        # THEN — Food: mean(30000, 60000, 90000) = 60000; last = May's 90000.
        food = next(line for line in history.categories if line.category == "Food")
        assert food.avg3mo == Decimal("60000.00")
        assert food.last_month == Decimal("90000.00")
        # Transport spent only in May -> 9000 / 3 = 3000; last = 9000.
        transport = next(line for line in history.categories if line.category == "Transport")
        assert transport.avg3mo == Decimal("3000.00")
        assert transport.last_month == Decimal("9000.00")

    async def test_empty_history_yields_no_categories(self):
        """
        GIVEN a session whose three executes return no spend
        WHEN category_history runs
        THEN no category lines are produced
        """
        # GIVEN — three months, each a gross + a reduction query (all empty).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),
            _result([]),
            _result([]),
            _result([]),
            _result([]),
            _result([]),
        ]
        reader = SqlAlchemyBudgetReader(session)

        # WHEN
        history = await reader.category_history(date(2026, 6, 1), A_USER)

        # THEN
        assert history.categories == []

    async def test_usd_history_sums_snapshot_and_excludes_null_rows(self):
        """
        GIVEN a USD history request whose three executes return usd_amount totals
        WHEN category_history runs with currency=USD
        THEN it aggregates the snapshot totals AND each query excludes null-snapshot rows
             (the USD spend path's exclusion threads through, ADR-152)
        """
        # GIVEN — three months of USD-denominated Food spend (oldest-first), each with
        # an (empty) reimbursement-reduction query interleaved (ADR-160).
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("30.00"))]),
            _result([]),  # March reductions (none)
            _result([_category_row("Food", Decimal("60.00"))]),
            _result([]),  # April reductions (none)
            _result([_category_row("Food", Decimal("90.00"))]),
            _result([]),  # May reductions (none)
        ]
        reader = SqlAlchemyBudgetReader(session)

        # WHEN
        history = await reader.category_history(date(2026, 6, 15), A_USER, Currency.USD)

        # THEN — each query filters out rows lacking a usd_amount snapshot (ADR-152).
        assert session.execute.await_count == 6
        for call in session.execute.await_args_list:
            (statement,) = call.args
            assert "usd_amount is not null" in str(statement).lower()

        # THEN — USD history sums the snapshot: mean(30, 60, 90) = 60.00; last = May's 90.00.
        food = next(line for line in history.categories if line.category == "Food")
        assert food.avg3mo == Decimal("60.00")
        assert food.last_month == Decimal("90.00")
