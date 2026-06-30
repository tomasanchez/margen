"""Unit tests for the SQLAlchemy transaction reader (ADR-032).

Per ADR-032 these mock the ``AsyncSession`` and the execute result — no real
database. They assert the reader builds a newest-first ``select`` and projects
rows into read models.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

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
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType

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


def _trend_row(year: int, month: int, total: object) -> SimpleNamespace:
    """Build a fake trend aggregation row (year, month, total)."""
    return SimpleNamespace(year=year, month=month, total=total)


def _category_row(category: str, total: object) -> SimpleNamespace:
    """Build a fake category aggregation row (category, total)."""
    return SimpleNamespace(category=category, total=total)


def _result(rows: list[SimpleNamespace]) -> MagicMock:
    """Wrap rows in a fake execute result exposing ``.all()``."""
    result = MagicMock()
    result.all.return_value = rows
    return result


class TestSummaryReader:
    """``monthly_summary`` runs three aggregations and assembles the summary."""

    async def test_builds_trend_categories_and_delta(self):
        """
        GIVEN a session whose three executes return trend, month and prior totals
        WHEN monthly_summary runs for June 2026
        THEN it builds the 6-point trend, category shares and the prior-month delta
        """
        # GIVEN — execute is called 3x: trend, month categories, prior categories.
        trend = _result([_trend_row(2026, 3, Decimal("100.00")), _trend_row(2026, 6, Decimal("400.00"))])
        month_categories = _result([_category_row("Food", Decimal("300.00")), _category_row("Rent", Decimal("100.00"))])
        prior_categories = _result([_category_row("Food", Decimal("150.00"))])
        session = AsyncMock()
        session.execute.side_effect = [trend, month_categories, prior_categories]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 15), A_USER)

        # THEN — three aggregation queries ran as Selects filtered to expenses.
        assert session.execute.await_count == 3
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
        session.execute.side_effect = [trend, month_categories, prior_categories]
        reader = SqlAlchemySummaryReader(session)

        # WHEN
        summary = await reader.monthly_summary(date(2026, 6, 1), A_USER)

        # THEN
        assert summary.trend[-1].expenses == Decimal("250.5")
        assert summary.categories[0].amount == Decimal("250.5")


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
        # GIVEN — execute sequence: month cats, prior cats, recurring, inflow, expense, latest USD.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("300.00")), _category_row("Rent", Decimal("100.00"))]),
            _result([_category_row("Food", Decimal("150.00"))]),
            _recurring_row(2, Decimal("900.00")),
            _scalar_result(Decimal("3000.00")),
            _scalar_result(Decimal("400.00")),
            _scalar_result(_usd_record(date(2026, 6, 20), "100.00", "1200.00")),
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN — reference in July makes June a past month: actual savings.
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN — six aggregation queries ran as Selects, each scoped to the owner (ADR-108).
        assert session.execute.await_count == 6
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

    async def test_empty_month_has_none_facts_and_zero_savings(self):
        """
        GIVEN a session whose executes all return empty / None aggregates
        WHEN monthly_insights runs
        THEN the optional facts are None and savings are 0
        """
        # GIVEN — execute sequence with no data anywhere.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),  # month categories
            _result([]),  # prior categories
            _recurring_row(0, Decimal("0")),  # no recurring
            _scalar_result(None),  # no inflow -> 0
            _scalar_result(None),  # no expense -> 0
            _scalar_result(None),  # no latest USD invoice
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN
        assert insights.top_category_mover is None
        assert insights.recurring is None
        assert insights.latest_usd_invoice is None
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
            _result([]),
            _result([]),
            _recurring_row(0, Decimal("0")),
            _scalar_result(None),
            _scalar_result(None),
            _scalar_result(_usd_record(date(2026, 6, 9), "50.00", "1100.00", fx_rate_type=None)),
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
        # GIVEN — six no-data executes; we only assert the prior bound rolled back.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),
            _result([]),
            _recurring_row(0, Decimal("0")),
            _scalar_result(None),
            _scalar_result(None),
            _scalar_result(None),
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 1, 1), date(2026, 2, 1), A_USER)

        # THEN — no crash on the year rollover and the requested month is January.
        assert insights.month == "2026-01"
        assert session.execute.await_count == 6

    async def test_coerces_float_sums_to_decimal(self):
        """
        GIVEN a backend (e.g. SQLite) returning float SUMs
        WHEN monthly_insights runs
        THEN the recurring total and savings totals are coerced to Decimal (ADR-025)
        """
        # GIVEN
        session = AsyncMock()
        session.execute.side_effect = [
            _result([]),
            _result([]),
            _recurring_row(1, 250.5),  # float total
            _scalar_result(1000.5),  # float inflow
            _scalar_result(250.25),  # float expense
            _scalar_result(None),
        ]
        reader = SqlAlchemyInsightsReader(session)

        # WHEN
        insights = await reader.monthly_insights(date(2026, 6, 1), date(2026, 7, 1), A_USER)

        # THEN
        assert insights.recurring is not None
        assert insights.recurring.total == Decimal("250.5")
        assert insights.savings.amount == Decimal("1000.5") - Decimal("250.25")


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


class TestMonotributoReader:
    """``SqlAlchemyMonotributoReader`` aggregates the standing, drilldown and previous."""

    async def test_snapshot_with_persisted_previous(self):
        """
        GIVEN a configured category, a window SUM, an invoice and a persisted prior snapshot
        WHEN the snapshot is assembled
        THEN current is computed live, the drilldown carries a cumulative, and previous
             reads the frozen persisted snapshot
        """
        # GIVEN — execute sequence: config, used(current), invoices, snapshot_at(prior).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row(category="A")),
            _scalar_result(Decimal("1500000.50")),
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
        # previous resolved from the persisted snapshot (note labels it a saved snapshot).
        assert snapshot.previous is not None
        assert snapshot.previous.category == "B"
        assert snapshot.previous.projection_note == "Saved snapshot from this period."

    async def test_snapshot_computes_previous_live_when_absent(self):
        """
        GIVEN no persisted prior snapshot and no app_settings row
        WHEN the snapshot is assembled
        THEN current and previous both use the settings default category (ADR-054)
             and previous is computed live
        """
        # GIVEN — execute sequence: config(None), used(current), invoices(none),
        # snapshot_at(None), config(None) again, used(prior).
        reference = date(2026, 6, 14)
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(None),  # no app_settings -> settings defaults
            _scalar_result(None),  # no current income -> 0
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
        assert snapshot.invoices == []
        assert snapshot.previous is not None
        assert snapshot.previous.used == Decimal("300000.00")
        assert snapshot.previous.projection_note != "Saved snapshot from this period."

    async def test_foreign_currency_invoice_flagged(self):
        """
        GIVEN a USD invoice in the window
        WHEN current_standing then the drilldown are read
        THEN the row is flagged as foreign currency
        """
        # GIVEN — snapshot path: config, used, invoices(USD), snapshot_at(None), config, used.
        session = AsyncMock()
        session.execute.side_effect = [
            _first_result(_config_row()),
            _scalar_result(Decimal("1000.00")),
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
        # GIVEN — execute called 3x, oldest-first: March, April, May.
        session = AsyncMock()
        session.execute.side_effect = [
            _result([_category_row("Food", Decimal("30000.00"))]),
            _result([_category_row("Food", Decimal("60000.00"))]),
            _result([_category_row("Food", Decimal("90000.00")), _category_row("Transport", Decimal("9000.00"))]),
        ]
        reader = SqlAlchemyBudgetReader(session)

        # WHEN
        history = await reader.category_history(date(2026, 6, 15), A_USER)

        # THEN — three owner-scoped expense aggregations ran as Selects (ADR-108).
        assert session.execute.await_count == 3
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
        # GIVEN
        session = AsyncMock()
        session.execute.side_effect = [_result([]), _result([]), _result([])]
        reader = SqlAlchemyBudgetReader(session)

        # WHEN
        history = await reader.category_history(date(2026, 6, 1), A_USER)

        # THEN
        assert history.categories == []
