"""SQLAlchemy reader for the reports query side (ADR-163, ADR-164).

Runs read-only queries against an ``AsyncSession`` to build the net-worth history
series. The cumulative roll-up and windowing live in the pure
:mod:`margen_api.service_layer.net_worth_history`; this adapter only does the SQL
(AGENTS.md). Two aggregates feed the series, mirroring the current snapshot's
signed-delta + transfer-flow model (ADR-122/123/135) but grouped by month:

* the SUM of every account's ``opening_balance`` per currency (the starting point);
* the per-month INCREMENTAL signed flow per currency — transaction deltas
  (``+`` inflow, ``-`` expense, in the account's native magnitude) PLUS the net
  transfer flow (``+amount_in`` to a destination, ``-amount_out`` from a source).

Flow dated BEFORE the window's first month is folded into that first month's key so
a balance carried into the window is reflected, not lost. No FX conversion happens
here — the series is per-currency native (ADR-164). Every query is owner-scoped
(ADR-131). All I/O is awaited.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.account import AccountRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.models.transfer import TransferRecord
from margen_api.adapters.queries import (
    _range_month_category_gross_expense_totals,
    _range_month_category_reimbursement_totals,
)
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.net_worth_history import (
    DEFAULT_MONTHS,
    build_net_worth_history,
    clamp_months,
    history_window,
    month_key,
)
from margen_api.service_layer.reports_overview import (
    SPARKLINE_MONTHS,
    add_months,
    build_overview,
    resolve_windows,
)
from margen_api.service_layer.reports_overview_read_models import ReportsOverview
from margen_api.service_layer.reports_read_models import NetWorthHistory
from margen_api.service_layer.reports_reader import AbstractReportsReader
from margen_api.service_layer.summaries import UNCATEGORIZED

_ZERO = Decimal(0)
# Ordinary inflow for the Reports income KPI: income + invoice, NOT reimbursement
# (a reimbursement is never ordinary income, ADR-158). Mirrors ``queries._INFLOW_KINDS``.
_INFLOW_KINDS = (Kind.INCOME.value, Kind.INVOICE.value)
# Null categories bucket under one label, matching the ARS net-expense aggregation
# (ADR-042) so the USD trend path buckets identically to the shared range gross.
_UNCATEGORIZED = UNCATEGORIZED


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


class SqlAlchemyReportsReader(AbstractReportsReader):
    """Serve the net-worth history series from server-side SQL (ADR-164)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def overview(
        self,
        user_id: str,
        *,
        range_key: str,
        currency: Currency = Currency.ARS,
    ) -> ReportsOverview:
        """Assemble the owner's range-based Reports overview (ADR-167, ADR-169, ADR-131).

        Resolves the range into the current and previous windows plus the
        trailing-6-month sparkline range, runs the per-month currency-aware
        aggregations over the union of those months (one bounded range scan per
        aggregate), and hands the raw figures to the pure
        :func:`~margen_api.service_layer.reports_overview.build_overview`. Every
        figure is denominated in ``currency`` (ADR-168): ARS sums ``amount``, USD
        sums the ``usd_amount`` snapshot excluding null-snapshot rows (ADR-152). The
        ``unconverted`` count surfaces those excluded rows on the USD path so a USD
        total is never silently understated. Scoped to ``user_id`` (ADR-131).
        """
        owner = UUID(user_id)
        reference = datetime.now(UTC).date()
        current_window, previous_window = resolve_windows(range_key, reference)
        current_month = date(reference.year, reference.month, 1)
        sparkline_start = add_months(current_month, -(SPARKLINE_MONTHS - 1))
        # The bounded scan spans the earliest of the previous window and the
        # sparkline range through the month after the current window's end.
        oldest = min(previous_window[0], sparkline_start)
        upper = add_months(current_window[-1], 1)
        is_usd = currency is Currency.USD

        income_by_month = await self._monthly_flow_totals(owner, oldest, upper, _INFLOW_KINDS, is_usd=is_usd)
        expense_by_month_category = await self._range_net_expense_by_category(owner, oldest, upper, is_usd=is_usd)
        expenses_by_month = {
            month: sum(categories.values(), _ZERO) for month, categories in expense_by_month_category.items()
        }
        avg_rate_by_month = await self._monthly_avg_rate(owner, oldest, upper)
        usd_invoiced_by_month = await self._monthly_usd_invoiced(owner, oldest, upper)
        unconverted = await self._range_unconverted_count(owner, oldest, upper) if is_usd else 0
        return build_overview(
            range_key,
            reference,
            currency.value,
            income_by_month=income_by_month,
            expenses_by_month=expenses_by_month,
            expense_by_month_category=expense_by_month_category,
            avg_rate_by_month=avg_rate_by_month,
            usd_invoiced_by_month=usd_invoiced_by_month,
            unconverted=unconverted,
        )

    async def _monthly_flow_totals(
        self,
        owner: UUID,
        oldest: date,
        upper: date,
        kinds: tuple[str, ...],
        *,
        is_usd: bool,
    ) -> dict[str, Decimal]:
        """SUM the owner's ``kinds`` totals over ``[oldest, upper)`` keyed by ``YYYY-MM`` (ADR-168).

        The currency-aware month total for the income / expense KPI legs: groups the
        matching ``kind`` rows by ``(year, month)`` and sums the authoritative
        ``amount`` for ARS, or the materialized ``usd_amount`` snapshot for USD —
        excluding null-snapshot rows so an unconverted row never forms a null-total
        bucket (ADR-152). Scoped to ``owner`` (ADR-108).
        """
        year = func.extract("year", TransactionRecord.occurred_on)
        month = func.extract("month", TransactionRecord.occurred_on)
        total_column = cast(
            func.sum(TransactionRecord.usd_amount if is_usd else TransactionRecord.amount),
            Numeric(18, 2),
        )
        predicates = [
            TransactionRecord.user_id == owner,
            TransactionRecord.kind.in_(kinds),
            TransactionRecord.occurred_on >= oldest,
            TransactionRecord.occurred_on < upper,
        ]
        if is_usd:
            # NOTE: snapshot-less ARS income is currently DROPPED from the USD income
            # KPI (no usd_amount to sum) rather than converted at the live rate. Per
            # ADR-156 income is never frozen with a backfilled snapshot, so it is not
            # counted as "unconverted" (see _range_unconverted_count); whether to
            # instead convert it dynamically for the USD KPI is a separate open item
            # the owner is deciding — do not change income summation here.
            predicates.append(TransactionRecord.usd_amount.is_not(None))
        statement = (
            select(year.label("year"), month.label("month"), total_column.label("total"))
            .where(*predicates)
            .group_by(year, month)
        )
        result = await self.session.execute(statement)
        return {f"{int(row.year):04d}-{int(row.month):02d}": _as_decimal(row.total) for row in result.all()}

    async def _range_net_expense_by_category(
        self,
        owner: UUID,
        oldest: date,
        upper: date,
        *,
        is_usd: bool,
    ) -> dict[str, dict[str, Decimal]]:
        """Return NET expense totals keyed by ``YYYY-MM`` then category over ``[oldest, upper)`` (ADR-160).

        ARS reuses the shared range gross + reimbursement aggregations and nets each
        category per month, floored at zero (ADR-160/162), so the Reports category
        trends match the budgets / summaries net spend exactly. USD sums the
        ``usd_amount`` snapshot per ``(month, category)`` excluding null-snapshot rows
        (ADR-152); the reimbursement net-off is intentionally NOT applied on the USD
        path here (the trend surface reads gross USD, consistent with the net-worth
        USD magnitude), keeping the USD exclusion set simple and matching the
        ``unconverted`` count. Scoped to ``owner`` (ADR-108).
        """
        if is_usd:
            return await self._range_gross_expense_by_category_usd(owner, oldest, upper)
        gross = await _range_month_category_gross_expense_totals(self.session, oldest, upper, owner)
        reductions = await _range_month_category_reimbursement_totals(self.session, oldest, upper, owner)
        months = set(gross) | set(reductions)
        net: dict[str, dict[str, Decimal]] = {}
        for key in months:
            month_gross = gross.get(key, {})
            month_reductions = reductions.get(key, {})
            month_net: dict[str, Decimal] = {}
            for category in set(month_gross) | set(month_reductions):
                remaining = month_gross.get(category, _ZERO) - month_reductions.get(category, _ZERO)
                if remaining > _ZERO:
                    month_net[category] = remaining
            if month_net:
                net[key] = month_net
        return net

    async def _range_gross_expense_by_category_usd(
        self,
        owner: UUID,
        oldest: date,
        upper: date,
    ) -> dict[str, dict[str, Decimal]]:
        """Return USD gross expense totals keyed by ``YYYY-MM`` then category (ADR-152).

        Sums the ``usd_amount`` snapshot for ``kind='expense'`` over ``[oldest, upper)``
        grouped by ``(year, month, category)`` (NULL categories bucket under
        ``Uncategorized``), excluding null-snapshot rows so an unconverted row never
        forms a null-total bucket. Scoped to ``owner`` (ADR-108).
        """
        year = func.extract("year", TransactionRecord.occurred_on)
        month = func.extract("month", TransactionRecord.occurred_on)
        category = func.coalesce(TransactionRecord.category, _UNCATEGORIZED)
        total = cast(func.sum(TransactionRecord.usd_amount), Numeric(18, 2))
        statement = (
            select(year.label("year"), month.label("month"), category.label("category"), total.label("total"))
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.kind == Kind.EXPENSE.value,
                TransactionRecord.usd_amount.is_not(None),
                TransactionRecord.occurred_on >= oldest,
                TransactionRecord.occurred_on < upper,
            )
            .group_by(year, month, category)
        )
        result = await self.session.execute(statement)
        totals: dict[str, dict[str, Decimal]] = {}
        for row in result.all():
            key = f"{int(row.year):04d}-{int(row.month):02d}"
            totals.setdefault(key, {})[str(row.category)] = _as_decimal(row.total)
        return totals

    async def _monthly_avg_rate(self, owner: UUID, oldest: date, upper: date) -> dict[str, Decimal]:
        """Return the per-month average captured ``fx_rate`` over ``[oldest, upper)`` (ADR-148).

        Averages the snapshotted ``fx_rate`` per ``(year, month)`` across the owner's
        rows that carry one (null-rate rows are excluded from both the AVG numerator
        and denominator), so a month with no snapshot is simply absent and the FX
        panel degrades gracefully. Scoped to ``owner`` (ADR-108).
        """
        year = func.extract("year", TransactionRecord.occurred_on)
        month = func.extract("month", TransactionRecord.occurred_on)
        avg_rate = cast(func.avg(TransactionRecord.fx_rate), Numeric(18, 6))
        statement = (
            select(year.label("year"), month.label("month"), avg_rate.label("rate"))
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.fx_rate.is_not(None),
                TransactionRecord.occurred_on >= oldest,
                TransactionRecord.occurred_on < upper,
            )
            .group_by(year, month)
        )
        result = await self.session.execute(statement)
        return {f"{int(row.year):04d}-{int(row.month):02d}": _as_decimal(row.rate) for row in result.all()}

    async def _monthly_usd_invoiced(self, owner: UUID, oldest: date, upper: date) -> dict[str, Decimal]:
        """Return the per-month SUM of USD-native invoiced/income ``usd_amount`` (ADR-167).

        Sums the ``usd_amount`` snapshot for USD-native inflow rows (income + invoice,
        ADR-158) that carry a snapshot, grouped by ``(year, month)``, over
        ``[oldest, upper)``. Scoped to ``owner`` (ADR-108).
        """
        year = func.extract("year", TransactionRecord.occurred_on)
        month = func.extract("month", TransactionRecord.occurred_on)
        total = cast(func.sum(TransactionRecord.usd_amount), Numeric(18, 2))
        statement = (
            select(year.label("year"), month.label("month"), total.label("total"))
            .where(
                TransactionRecord.user_id == owner,
                TransactionRecord.kind.in_(_INFLOW_KINDS),
                TransactionRecord.currency == Currency.USD.value,
                TransactionRecord.usd_amount.is_not(None),
                TransactionRecord.occurred_on >= oldest,
                TransactionRecord.occurred_on < upper,
            )
            .group_by(year, month)
        )
        result = await self.session.execute(statement)
        return {f"{int(row.year):04d}-{int(row.month):02d}": _as_decimal(row.total) for row in result.all()}

    async def _range_unconverted_count(self, owner: UUID, oldest: date, upper: date) -> int:
        """Count the window's EXPENSE rows lacking a USD snapshot (ADR-150, ADR-156, ADR-108).

        The unconverted-note figure for the USD Reports denomination: how many
        ``expense`` rows over ``[oldest, upper)`` carry a null ``usd_amount`` — the
        pre-backfill rows and statement imports pending the client rate-fill step
        (ADR-149) that CAN legitimately be backfilled at their ``occurred_on`` rate
        (ADR-150), so the USD spend figure is not silently understated.

        Income (``income`` / ``invoice``) is deliberately EXCLUDED: ARS income has no
        FX snapshot by design (ADR-156) — it converts dynamically at the live rate and
        must never be frozen with a backfilled snapshot. Counting snapshot-less income
        here over-reported the figure and misleadingly nudged the user to backfill
        income that should stay dynamic. Scoped to ``owner`` (ADR-108).
        """
        statement = select(func.count()).where(
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.EXPENSE.value,
            TransactionRecord.usd_amount.is_(None),
            TransactionRecord.occurred_on >= oldest,
            TransactionRecord.occurred_on < upper,
        )
        return int((await self.session.execute(statement)).scalar_one())

    async def net_worth_history(self, user_id: str, *, months: int = DEFAULT_MONTHS) -> NetWorthHistory:
        """Build the owner's cumulative month-END net-worth history per currency (ADR-164, ADR-131)."""
        owner = UUID(user_id)
        window = clamp_months(months)
        reference = datetime.now(UTC).date()
        first_month = history_window(reference, window)[0]

        opening = await self._opening_by_currency(owner)
        flow = await self._monthly_flow_by_currency(owner, first_month)
        return build_net_worth_history(
            reference,
            window,
            opening_by_currency=opening,
            monthly_flow_by_currency=flow,
        )

    async def _opening_by_currency(self, owner: UUID) -> dict[Currency, Decimal]:
        """Return the SUM of the owner's account opening balances keyed by currency (ADR-131)."""
        opening_sum = cast(func.coalesce(func.sum(AccountRecord.opening_balance), _ZERO), Numeric(18, 2))
        statement = (
            select(AccountRecord.currency, opening_sum.label("total"))
            .where(AccountRecord.user_id == owner)
            .group_by(AccountRecord.currency)
        )
        result = await self.session.execute(statement)
        return {Currency.parse(row.currency): _as_decimal(row.total) for row in result.all()}

    async def _monthly_flow_by_currency(
        self,
        owner: UUID,
        first_month: date,
    ) -> dict[Currency, dict[str, Decimal]]:
        """Return the per-month incremental signed flow keyed by currency then ``YYYY-MM`` (ADR-164).

        Combines the transaction signed deltas and the net transfer flow, each in
        the account's native currency. Flow dated before ``first_month`` is folded
        into ``first_month``'s key so the opening cumulative includes it (a balance
        carried into the window is not lost).
        """
        flow: dict[Currency, dict[str, Decimal]] = {}
        for currency, key, amount in await self._transaction_flow(owner, first_month):
            flow.setdefault(currency, {}).setdefault(key, _ZERO)
            flow[currency][key] += amount
        for currency, key, amount in await self._transfer_flow(owner, first_month):
            flow.setdefault(currency, {}).setdefault(key, _ZERO)
            flow[currency][key] += amount
        return flow

    def _bucket(self, occurred_on: date, first_month: date) -> str:
        """Bucket a movement date into its ``YYYY-MM`` key, clamped to the window start.

        A movement before ``first_month`` folds into the first month so its balance
        contribution lands in the opening cumulative rather than being dropped.
        """
        if occurred_on < first_month:
            return month_key(first_month)
        return month_key(occurred_on)

    async def _transaction_flow(
        self,
        owner: UUID,
        first_month: date,
    ) -> list[tuple[Currency, str, Decimal]]:
        """Return each account-linked transaction's signed native delta bucketed by month (ADR-122).

        The signed delta is ``-magnitude`` for an expense and ``+magnitude`` for every
        inflow (income / invoice / reimbursement), in the account's native currency
        (ADR-123). Only transactions attributed to an account contribute to net worth
        (a null ``account_id`` is excluded, ADR-122). Scoped to the owner on BOTH
        the transaction and the joined account so the two net-worth paths anchor on
        the account owner identically to the snapshot in ``account_queries`` (ADR-131).
        """
        native_usd = func.coalesce(TransactionRecord.usd_amount, TransactionRecord.amount)
        statement = (
            select(
                AccountRecord.currency.label("currency"),
                TransactionRecord.occurred_on.label("occurred_on"),
                TransactionRecord.kind.label("kind"),
                TransactionRecord.amount.label("amount"),
                native_usd.label("native_usd"),
            )
            .join(
                AccountRecord,
                (AccountRecord.id == TransactionRecord.account_id) & (AccountRecord.user_id == owner),
            )
            .where(TransactionRecord.user_id == owner)
        )
        result = await self.session.execute(statement)
        flows: list[tuple[Currency, str, Decimal]] = []
        for row in result.all():
            currency = Currency.parse(row.currency)
            magnitude = _as_decimal(row.native_usd) if currency is Currency.USD else _as_decimal(row.amount)
            delta = -magnitude if Kind.parse(row.kind) is Kind.EXPENSE else magnitude
            flows.append((currency, self._bucket(row.occurred_on, first_month), delta))
        return flows

    async def _transfer_flow(
        self,
        owner: UUID,
        first_month: date,
    ) -> list[tuple[Currency, str, Decimal]]:
        """Return each transfer's native flow — credit to destination, debit from source (ADR-135).

        A transfer adds ``amount_in`` to its destination account's currency and
        subtracts ``amount_out`` from its source account's currency, in each account's
        native currency (ADR-123), so a same-currency transfer nets to zero in the
        series. Scoped to the owner (ADR-131).
        """
        source = AccountRecord.__table__.alias("source_account")
        destination = AccountRecord.__table__.alias("destination_account")
        statement = (
            select(
                source.c.currency.label("source_currency"),
                destination.c.currency.label("destination_currency"),
                TransferRecord.amount_out.label("amount_out"),
                TransferRecord.amount_in.label("amount_in"),
                TransferRecord.occurred_on.label("occurred_on"),
            )
            .join(source, source.c.id == TransferRecord.from_account_id)
            .join(destination, destination.c.id == TransferRecord.to_account_id)
            .where(TransferRecord.user_id == owner)
        )
        result = await self.session.execute(statement)
        flows: list[tuple[Currency, str, Decimal]] = []
        for row in result.all():
            key = self._bucket(row.occurred_on, first_month)
            flows.append((Currency.parse(row.destination_currency), key, _as_decimal(row.amount_in)))
            flows.append((Currency.parse(row.source_currency), key, -_as_decimal(row.amount_out)))
        return flows
