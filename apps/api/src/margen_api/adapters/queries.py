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

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.settings_repository import (
    DEFAULT_DISPLAY_CURRENCY,
    DEFAULT_FX_RATE_TYPE,
    DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    DEFAULT_MONOTRIBUTO_CATEGORY,
)
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType
from margen_api.service_layer.insights import build_monthly_insights
from margen_api.service_layer.insights_read_models import LatestUsdInvoice, MonthlyInsights
from margen_api.service_layer.insights_reader import AbstractInsightsReader
from margen_api.service_layer.monotributo import (
    build_snapshot,
    build_standing,
    prior_window,
    trailing_window,
)
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoSnapshot,
    MonotributoStanding,
)
from margen_api.service_layer.monotributo_reader import AbstractMonotributoReader
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.settings_read_models import AppSettings
from margen_api.service_layer.settings_reader import AbstractSettingsReader
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


_ZERO = Decimal(0)


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


# Savings income is the inflow kinds (income + invoice), independent of the
# Monotributo flag -- savings track real money in, not the taxable subset (ADR-060).
_INFLOW_KINDS = (Kind.INCOME.value, Kind.INVOICE.value)
# Recurring expenses: kind 'expense' carrying the recurring flag (ADR-031/ADR-060).
_RECURRING_EXPENSE = (
    TransactionRecord.kind == Kind.EXPENSE.value,
    TransactionRecord.recurring.is_(True),
)


def _month_upper_bound(month: date) -> date:
    """Return the first day of the month after ``month`` (exclusive upper bound)."""
    return date(month.year + (month.month // 12), (month.month % 12) + 1, 1)


class SqlAlchemyInsightsReader(AbstractInsightsReader):
    """Serve the monthly insight facts from server-side SQL aggregation (ADR-060, ADR-061).

    Runs read-only ``SUM`` / ``GROUP BY`` / latest-row queries over the
    ``transactions`` table and projects the raw aggregates into a
    :class:`MonthlyInsights` of structured facts. SQLAlchemy stays in this adapter;
    the mover selection, recurring passthrough and savings projection live in the
    pure :mod:`margen_api.service_layer.insights`. The reader never mutates state.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def monthly_insights(self, month: date, reference: date) -> MonthlyInsights:
        """Aggregate the structured insight facts for a month (ADR-060, ADR-061)."""
        prior = date(month.year - 1, 12, 1) if month.month == 1 else date(month.year, month.month - 1, 1)

        month_category_totals = await self._expense_category_totals(month)
        prior_category_totals = await self._expense_category_totals(prior)
        recurring_count, recurring_total = await self._recurring_expenses(month)
        income_total = await self._inflow_total(month)
        expense_total = await self._expense_total(month)
        latest_usd_invoice = await self._latest_usd_invoice(month)

        return build_monthly_insights(
            month,
            reference,
            month_category_totals=month_category_totals,
            prior_category_totals=prior_category_totals,
            recurring_count=recurring_count,
            recurring_total=recurring_total,
            income_total=income_total,
            expense_total=expense_total,
            latest_usd_invoice=latest_usd_invoice,
        )

    async def _expense_category_totals(self, month: date) -> dict[str, Decimal]:
        """Return the month's expense totals keyed by category (mover input)."""
        statement = (
            select(_CATEGORY.label("category"), _EXPENSE_AMOUNT.label("total"))
            .where(
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.occurred_on >= month,
                TransactionRecord.occurred_on < _month_upper_bound(month),
            )
            .group_by(_CATEGORY)
        )
        result = await self.session.execute(statement)
        return {str(row.category): _as_decimal(row.total) for row in result.all()}

    async def _recurring_expenses(self, month: date) -> tuple[int, Decimal]:
        """Return the count and ARS-equivalent total of recurring expenses."""
        statement = select(
            func.count().label("recurring_count"),
            cast(func.coalesce(func.sum(TransactionRecord.amount), _ZERO), Numeric(18, 2)).label("recurring_total"),
        ).where(
            *_RECURRING_EXPENSE,
            TransactionRecord.occurred_on >= month,
            TransactionRecord.occurred_on < _month_upper_bound(month),
        )
        row = (await self.session.execute(statement)).one()
        return int(row.recurring_count), _as_decimal(row.recurring_total)

    async def _inflow_total(self, month: date) -> Decimal:
        """SUM the month's ARS-equivalent income + invoice amounts (savings input)."""
        statement = select(cast(func.sum(TransactionRecord.amount), Numeric(18, 2))).where(
            TransactionRecord.kind.in_(_INFLOW_KINDS),
            TransactionRecord.occurred_on >= month,
            TransactionRecord.occurred_on < _month_upper_bound(month),
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        return _ZERO if total is None else _as_decimal(total)

    async def _expense_total(self, month: date) -> Decimal:
        """SUM the month's ARS-equivalent expense amounts (savings input)."""
        statement = select(_EXPENSE_AMOUNT).where(
            TransactionRecord.kind == Kind.EXPENSE.value,
            TransactionRecord.occurred_on >= month,
            TransactionRecord.occurred_on < _month_upper_bound(month),
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        return _ZERO if total is None else _as_decimal(total)

    async def _latest_usd_invoice(self, month: date) -> LatestUsdInvoice | None:
        """Return the month's most recent USD INVOICE with an applied rate.

        Only ``invoice``-kind rows qualify — the insight is "latest invoice", so a
        USD expense (e.g. a fee paid in dollars) must not surface here (it would
        read as a positive invoice, ADR-060). The row must be in USD and carry both
        a ``usd_amount`` and an ``fx_rate``. Ordered newest-first by ``occurred_on``
        (``created_at`` as a stable tiebreak) and limited to one.
        """
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.kind == Kind.INVOICE.value,
                TransactionRecord.currency == Currency.USD.value,
                TransactionRecord.usd_amount.is_not(None),
                TransactionRecord.fx_rate.is_not(None),
                TransactionRecord.occurred_on >= month,
                TransactionRecord.occurred_on < _month_upper_bound(month),
            )
            .order_by(TransactionRecord.occurred_on.desc(), TransactionRecord.created_at.desc())
            .limit(1)
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None or record.usd_amount is None or record.fx_rate is None:
            return None
        return LatestUsdInvoice(
            usd=record.usd_amount,
            rate=record.fx_rate,
            rate_type=record.fx_rate_type if record.fx_rate_type is not None else FxRateType.MEP.value,
            occurred_on=record.occurred_on,
        )


# Income that may count toward the Monotributo limit is the invoice/income kinds
# carrying the authoritative ``counts_toward_monotributo`` flag (ADR-027/ADR-046).
_MONOTRIBUTO_KINDS = (Kind.INVOICE.value, Kind.INCOME.value)
# SUM widens NUMERIC; cast back so the driver returns a Decimal for money (ADR-025).
_INCLUDED_AMOUNT = cast(func.sum(TransactionRecord.amount), Numeric(18, 2))
# Invoices that count toward the Monotributo limit: the invoice/income kinds
# carrying the authoritative flag (ADR-027/ADR-046).
_COUNTS_TOWARD_LIMIT = (
    TransactionRecord.kind.in_(_MONOTRIBUTO_KINDS),
    TransactionRecord.counts_toward_monotributo.is_(True),
)


class SqlAlchemyMonotributoReader(AbstractMonotributoReader):
    """Serve the Monotributo page from server-side aggregation (ADR-046, ADR-052).

    Runs read-only queries over ``transactions``, ``app_settings`` and
    ``monotributo_snapshot`` and projects them into a :class:`MonotributoSnapshot`.
    The standing math (status band, projection, margin) lives in the pure
    :mod:`margen_api.service_layer.monotributo`; this adapter only does I/O and
    never mutates state (the read-records write is a separate command, ADR-052).
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def snapshot(self, reference: date) -> MonotributoSnapshot:
        """Assemble the current standing, previous standing and drilldown."""
        current = await self.current_standing(reference)
        invoices = await self._invoices_in_window(current.period_start, current.period_end)
        previous = await self._previous_standing(reference)
        return build_snapshot(current=current, previous=previous, invoices=invoices)

    async def current_standing(self, reference: date) -> MonotributoStanding:
        """Compute the live trailing-12-month standing (ADR-046)."""
        window_start, window_end = trailing_window(reference)
        category, activity_type = await self._configured_category()
        used = await self._used_in_window(window_start, window_end)
        return build_standing(
            used=used,
            category=category,
            activity_type=activity_type,
            window_start=window_start,
            window_end=window_end,
            reference=reference,
        )

    async def _previous_standing(self, reference: date) -> MonotributoStanding | None:
        """Resolve the prior-window standing from a snapshot, else compute it.

        Reads the persisted snapshot for the prior window's ``period_end`` when one
        exists (frozen historical figures, ADR-052); otherwise computes the prior
        window live so the comparison still has data on first read.
        """
        prior_start, prior_end = prior_window(reference)
        persisted = await self._snapshot_at(prior_end)
        if persisted is not None:
            return persisted
        category, activity_type = await self._configured_category()
        used = await self._used_in_window(prior_start, prior_end)
        return build_standing(
            used=used,
            category=category,
            activity_type=activity_type,
            window_start=prior_start,
            window_end=prior_end,
            reference=prior_end,
        )

    async def _configured_category(self) -> tuple[str, str]:
        """Return the ``(category, activity_type)`` from ``app_settings`` (ADR-054).

        The Monotributo category now lives in the single-row ``app_settings`` table
        (ADR-054, superseding the retired ``monotributo_config``); falls back to the
        documented settings defaults when no row exists yet.
        """
        statement = select(
            AppSettingsRecord.monotributo_current_category,
            AppSettingsRecord.monotributo_activity_type,
        ).limit(1)
        row = (await self.session.execute(statement)).first()
        if row is None:
            return DEFAULT_MONOTRIBUTO_CATEGORY, DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
        return str(row.monotributo_current_category), str(row.monotributo_activity_type)

    async def _used_in_window(self, window_start: date, window_end: date) -> Decimal:
        """SUM the included income over the inclusive ``[start, end]`` window."""
        statement = select(_INCLUDED_AMOUNT).where(
            *_COUNTS_TOWARD_LIMIT,
            TransactionRecord.occurred_on >= window_start,
            TransactionRecord.occurred_on <= window_end,
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        return _ZERO if total is None else _as_decimal(total)

    async def _invoices_in_window(self, window_start: date, window_end: date) -> list[MonotributoInvoice]:
        """List the counted invoices oldest-first with a running cumulative."""
        statement = (
            select(TransactionRecord)
            .where(
                *_COUNTS_TOWARD_LIMIT,
                TransactionRecord.occurred_on >= window_start,
                TransactionRecord.occurred_on <= window_end,
            )
            .order_by(TransactionRecord.occurred_on.asc(), TransactionRecord.created_at.asc())
        )
        result = await self.session.execute(statement)
        invoices: list[MonotributoInvoice] = []
        cumulative = _ZERO
        for record in result.scalars().all():
            cumulative += record.amount
            invoices.append(
                MonotributoInvoice(
                    id=record.id,
                    occurred_on=record.occurred_on,
                    name=record.name,
                    category=record.category,
                    amount=record.amount,
                    currency=record.currency,
                    cumulative=cumulative,
                    is_foreign_currency=Currency.parse(record.currency) is not Currency.ARS,
                )
            )
        return invoices

    async def _snapshot_at(self, period_end: date) -> MonotributoStanding | None:
        """Read a persisted standing for a ``period_end`` month, or ``None``."""
        statement = select(MonotributoSnapshotRecord).where(MonotributoSnapshotRecord.period_end == period_end).limit(1)
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return MonotributoStanding(
            category=record.category,
            activity_type=record.activity_type,
            limit=record.limit_amount,
            used=record.used,
            remaining=record.remaining,
            percent_used=record.percent_used,
            status=record.status,
            projected_category=record.projected_category,
            projection_note="Saved snapshot from this period.",
            period_start=record.period_start,
            period_end=record.period_end,
        )


class SqlAlchemySettingsReader(AbstractSettingsReader):
    """Serve the application settings from the single ``app_settings`` row (ADR-054).

    Runs a read-only query over ``app_settings`` and projects the single row into
    an :class:`AppSettings` read model. When no row exists yet it returns the
    documented defaults (ARS / MEP / category ``C`` / services) so the query side
    never returns ``None``. It never mutates state -- settings writes are a
    separate command on the unit of work (ADR-054).
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def get_settings(self) -> AppSettings:
        """Return the current settings, or the documented defaults when absent."""
        statement = select(AppSettingsRecord).limit(1)
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return AppSettings(
                preferred_display_currency=DEFAULT_DISPLAY_CURRENCY,
                fx_default_rate_type=DEFAULT_FX_RATE_TYPE,
                monotributo_current_category=DEFAULT_MONOTRIBUTO_CATEGORY,
                monotributo_activity_type=DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
            )
        return AppSettings(
            preferred_display_currency=record.preferred_display_currency,
            fx_default_rate_type=record.fx_default_rate_type,
            monotributo_current_category=record.monotributo_current_category,
            monotributo_activity_type=record.monotributo_activity_type,
        )
