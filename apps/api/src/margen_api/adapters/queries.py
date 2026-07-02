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
from sqlalchemy.orm import aliased

from margen_api.adapters.models.app_settings import AppSettingsRecord
from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.settings_repository import (
    DEFAULT_DISPLAY_CURRENCY,
    DEFAULT_FX_RATE_TYPE,
    DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
    DEFAULT_MONOTRIBUTO_CATEGORY,
    DEFAULT_MONOTRIBUTO_ENABLED,
    DEFAULT_PREFERRED_RATE_SOURCE,
)
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, RecurringCadence, TxType
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
        fx_source=record.fx_source,
        fx_rate_type=FxRateType(record.fx_rate_type) if record.fx_rate_type is not None else None,
        fx_rate_as_of=record.fx_rate_as_of,
        category=record.category,
        payment_method=record.payment_method,
        card=record.card,
        notes=record.notes,
        recurring=record.recurring,
        recurring_cadence=RecurringCadence.parse(record.recurring_cadence),
        installments_total=record.installments_total,
        installments_index=record.installments_index,
        counts_toward_monotributo=record.counts_toward_monotributo,
        statement_document_id=record.statement_document_id,
        account_id=record.account_id,
        offsets_transaction_id=record.offsets_transaction_id,
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

    async def list_transactions(self, user_id: str) -> list[TransactionReadModel]:
        """List the owner's transactions newest-first by ``occurred_on`` (ADR-030, ADR-108)."""
        statement = (
            select(TransactionRecord)
            .where(TransactionRecord.user_id == UUID(user_id))
            .order_by(
                TransactionRecord.occurred_on.desc(),
                TransactionRecord.created_at.desc(),
            )
        )
        result = await self.session.execute(statement)
        return [_to_read_model(record) for record in result.scalars().all()]

    async def get_transaction(self, transaction_id: UUID, user_id: str) -> TransactionReadModel | None:
        """Fetch one of the owner's transaction read models, or ``None`` (ADR-108, ADR-111).

        The ``user_id`` predicate is part of the lookup, so a foreign owner's id is
        simply not found — the boundary then answers 404 (ADR-111). The owner id is
        coerced to ``UUID`` to match the typed ownership column (ADR-094).
        """
        statement = select(TransactionRecord).where(
            TransactionRecord.id == transaction_id,
            TransactionRecord.user_id == UUID(user_id),
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _to_read_model(record)


# The persisted amount is ``NUMERIC(18, 2)``; SUM widens it, so cast the result
# back to NUMERIC so the driver returns a Decimal (not a float) for money (ADR-025).
_EXPENSE_AMOUNT = cast(func.sum(TransactionRecord.amount), Numeric(18, 2))
# The USD-budget spend path sums the materialized ``usd_amount`` snapshot instead
# (ADR-152); rows lacking a snapshot are excluded in the WHERE so they never form a
# null-total bucket — their count is surfaced separately as the unconverted note.
_EXPENSE_USD_AMOUNT = cast(func.sum(TransactionRecord.usd_amount), Numeric(18, 2))
# Null categories bucket under a single "Uncategorized" label (ADR-042).
_CATEGORY = func.coalesce(TransactionRecord.category, UNCATEGORIZED)


_ZERO = Decimal(0)


def _as_decimal(value: object) -> Decimal:
    """Coerce a SUM result to ``Decimal`` (SQLite may return a float)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


async def _month_category_gross_expense_totals(
    session: AsyncSession,
    month: date,
    owner: UUID,
    *,
    is_usd: bool,
) -> dict[str, Decimal]:
    """Return the owner's GROSS expense totals for a month keyed by category (ADR-042, ADR-152).

    The pre-netting expense sum: ``SUM`` of ``kind='expense'`` over the month grouped
    by category (NULL categories bucket under ``Uncategorized``, ADR-042), scoped to
    the owner (ADR-108). ``is_usd`` selects the summed column (ADR-152): ``False`` sums
    the authoritative ``amount``; ``True`` sums the materialized ``usd_amount`` snapshot
    and excludes rows lacking one so an unsnapshotted row never forms a null-total
    bucket. The linked-reimbursement subtraction that turns this into NET spend is
    applied by :func:`month_category_expense_totals` (ADR-160).
    """
    upper = _month_upper_bound(month)
    total_column = _EXPENSE_USD_AMOUNT if is_usd else _EXPENSE_AMOUNT
    predicates = [
        TransactionRecord.user_id == owner,
        TransactionRecord.kind == Kind.EXPENSE.value,
        TransactionRecord.occurred_on >= month,
        TransactionRecord.occurred_on < upper,
    ]
    if is_usd:
        # USD spend reads the stored snapshot; null-snapshot rows are excluded so
        # they never produce a null-total bucket (ADR-152).
        predicates.append(TransactionRecord.usd_amount.is_not(None))
    statement = select(_CATEGORY.label("category"), total_column.label("total")).where(*predicates).group_by(_CATEGORY)
    result = await session.execute(statement)
    return {str(row.category): _as_decimal(row.total) for row in result.all()}


async def month_category_reimbursement_totals(
    session: AsyncSession,
    month: date,
    owner: UUID,
    currency: Currency = Currency.ARS,
) -> dict[str, Decimal]:
    """Return the reimbursement reductions for a month keyed by the LINKED EXPENSE's category (ADR-159, ADR-161).

    Sums each ``kind='reimbursement'`` payback attributed to its LINKED EXPENSE'S
    ``(category, occurred_on month)`` — never the payback's own date (ADR-159) — so
    credit-card timing skew nets against the right budget month. The reimbursement's
    linked expense is reached through the ``offsets_transaction_id`` self-FK; the
    expense is scoped to ``owner`` and to the requested month, and only ``kind='expense'``
    targets contribute (a stray non-expense link would have been rejected at write time,
    ADR-159). Both the payback and its expense need not share an owner row here — the
    write-time same-owner guard (ADR-130) already ensures they match.

    ``currency`` selects the reduction basis (ADR-161):

    * ``ARS`` — exact ``SUM(reimbursement.amount)`` on the authoritative ARS column
      (no FX, ADR-160).
    * ``USD`` — ``SUM(expense.usd_amount * (reimbursement.amount / expense.amount))``:
      the payback's USD reduction rides the EXPENSE'S captured rate (ADR-161), NOT the
      payback date's rate. This proportional form is mathematically identical to
      ``reimbursement.amount / expense.fx_rate`` (since ``usd_amount = amount / fx_rate``)
      but depends only on ``usd_amount`` (and a non-zero ``amount``), so its exclusion set
      MATCHES the gross USD side EXACTLY (``usd_amount IS NOT NULL``, ADR-152). A legacy
      expense with a ``usd_amount`` snapshot but a NULL ``fx_rate`` (ADR-029/ADR-031) is
      therefore reduced by its paybacks here just as it is counted on the gross side —
      the two exclusion sets no longer diverge and no unreduced spend leaks (ADR-161).

    This is the raw (unfloored, unsubtracted) reduction map. The net spend and the
    over-refund floor are applied by :func:`month_category_expense_totals` (ADR-160/162);
    this map is also surfaced directly as each budget line's "reimbursed" figure so the
    client can render a reimbursed chip alongside the net spent.

    Args:
        session: The async session used for the read-only query.
        month: The first day of the requested calendar month.
        owner: The authenticated owner the expenses are scoped to (ADR-108).
        currency: ``ARS`` sums the payback ``amount`` (default); ``USD`` derives each
            payback's USD reduction from the linked expense's rate (ADR-161).

    Returns:
        Reimbursement reductions keyed by the LINKED EXPENSE'S category; empty when the
        month has no linked paybacks.
    """
    upper = _month_upper_bound(month)
    is_usd = currency is Currency.USD
    expense = aliased(TransactionRecord, name="linked_expense")
    reimbursement = aliased(TransactionRecord, name="reimbursement")
    category = func.coalesce(expense.category, UNCATEGORIZED)
    if is_usd:
        # The payback's USD reduction rides the EXPENSE'S captured rate (ADR-161) via the
        # PROPORTIONAL form usd_amount * (reimbursement.amount / expense.amount). It is
        # identical to reimbursement.amount / expense.fx_rate (usd_amount = amount / fx_rate)
        # but needs only usd_amount and a non-zero amount, so its exclusion set matches the
        # gross USD side EXACTLY (usd_amount IS NOT NULL) and legacy null-fx_rate snapshots
        # no longer leak unreduced spend. Summed and cast back to money precision (ADR-025).
        reduction = cast(
            func.sum(expense.usd_amount * (reimbursement.amount / expense.amount)),
            Numeric(18, 2),
        )
    else:
        reduction = cast(func.sum(reimbursement.amount), Numeric(18, 2))
    predicates = [
        expense.user_id == owner,
        expense.kind == Kind.EXPENSE.value,
        expense.occurred_on >= month,
        expense.occurred_on < upper,
        reimbursement.kind == Kind.REIMBURSEMENT.value,
    ]
    if is_usd:
        # Consistency with the gross USD side (ADR-152): an expense with no snapshot is
        # excluded from gross USD spend, so its paybacks must not reduce anything either.
        # The proportional form (above) needs only usd_amount, so this single predicate
        # makes the exclusion set MATCH the gross side exactly (no fx_rate divergence).
        # expense.amount is the authoritative money column and is always > 0 for an
        # expense (write-time invariant), so the division has no divide-by-zero risk.
        predicates.append(expense.usd_amount.is_not(None))
    statement = (
        select(category.label("category"), reduction.label("reduction"))
        .select_from(reimbursement)
        .join(expense, reimbursement.offsets_transaction_id == expense.id)
        .where(*predicates)
        .group_by(category)
    )
    result = await session.execute(statement)
    return {str(row.category): _as_decimal(row.reduction) for row in result.all()}


async def month_category_expense_totals(
    session: AsyncSession,
    month: date,
    owner: UUID,
    currency: Currency = Currency.ARS,
) -> dict[str, Decimal]:
    """Return the owner's NET expense totals for a month keyed by category (ADR-042, ADR-108, ADR-152, ADR-160).

    The canonical per-category month-expense aggregation reused by the summaries
    reader (ADR-042), the insights reader (ADR-060) and the budgets reader as the
    "spent" figure (ADR-125). It is **net spend** (ADR-160): the gross ``SUM`` of
    ``kind='expense'`` over the month, grouped by category (NULL categories bucket
    under ``Uncategorized``), MINUS the linked reimbursements attributed to each
    expense's ``(category, month)`` (ADR-159). Sharing one function keeps the budgets
    "spent" identical to the summaries "amount", the insights breakdown and the history
    trend — one aggregation, four surfaces (ADR-125), all net (ADR-160).

    The summed column depends on ``currency`` (ADR-152): for ``ARS`` (the default,
    preserving every existing caller) gross and reduction are both the authoritative
    ``amount``; for ``USD`` gross sums the materialized ``usd_amount`` snapshot (excluding
    null-snapshot rows, surfaced separately via :func:`month_expense_unconverted_count`)
    and each payback's USD reduction rides its linked expense's captured rate (ADR-161).

    The net per category is floored at ZERO (ADR-162): when linked paybacks for a
    category-month exceed the gross spend (friends over-transfer), the category never
    goes negative — it reads ``0``. The over-refund EXCESS surfaces as ordinary income
    attributed to the LINKED EXPENSE'S category-month (the same period the floor removed
    it from, so money is conserved across the spend and income books), handled by the
    income readers (ADR-162), not here — this query only ever returns non-negative
    category spend.

    Args:
        session: The async session used for the read-only query.
        month: The first day of the requested calendar month.
        owner: The authenticated owner the expenses are scoped to (ADR-108).
        currency: The budget currency; ``ARS`` nets on ``amount`` (default), ``USD``
            nets on the ``usd_amount`` snapshot / expense-rate derivation (ADR-152/161).

    Returns:
        NET expense totals for the month keyed by category, each floored at ``0``;
        absent categories are 0.
    """
    is_usd = currency is Currency.USD
    gross = await _month_category_gross_expense_totals(session, month, owner, is_usd=is_usd)
    reductions = await month_category_reimbursement_totals(session, month, owner, currency)
    if not reductions:
        return gross
    # Net = gross - reduction, floored at zero per category-month (ADR-160/162). A
    # category present only in the reduction map (a payback whose expense category has
    # no other spend) still floors at zero, never negative.
    net: dict[str, Decimal] = dict(gross)
    for category, reduction in reductions.items():
        remaining = net.get(category, _ZERO) - reduction
        net[category] = remaining if remaining > _ZERO else _ZERO
    return net


async def month_expense_unconverted_count(session: AsyncSession, month: date, owner: UUID) -> int:
    """Count the month's expense transactions lacking a USD snapshot (ADR-152, ADR-108).

    The unconverted-note figure for the USD budget surface: how many ``kind='expense'``
    rows in the month carry a null ``usd_amount`` (pre-backfill rows, statement imports
    pending the client rate-fill step, ADR-149). Surfaced so a USD spend total is never
    silently understated — the user can trigger a backfill (ADR-150). Scoped to the
    owner (ADR-108).

    Args:
        session: The async session used for the read-only query.
        month: The first day of the requested calendar month.
        owner: The authenticated owner the count is scoped to (ADR-108).

    Returns:
        The count of the month's expense transactions without a USD snapshot.
    """
    statement = select(func.count()).where(
        TransactionRecord.user_id == owner,
        TransactionRecord.kind == Kind.EXPENSE.value,
        TransactionRecord.occurred_on >= month,
        TransactionRecord.occurred_on < _month_upper_bound(month),
        TransactionRecord.usd_amount.is_(None),
    )
    return int((await session.execute(statement)).scalar_one())


async def _range_month_category_gross_expense_totals(
    session: AsyncSession,
    oldest: date,
    upper: date,
    owner: UUID,
) -> dict[str, dict[str, Decimal]]:
    """Return ARS gross expense totals keyed by ``YYYY-MM`` then category (ADR-042, ADR-160).

    The trend-window gross counterpart of :func:`_month_category_gross_expense_totals`:
    ``SUM`` of ``kind='expense'`` over the half-open ``[oldest, upper)`` range, grouped
    by ``(year, month, category)`` (NULL categories bucket under ``Uncategorized``,
    ADR-042) and scoped to ``owner`` (ADR-108). Grouping by category (not just month) is
    what lets the trend net PER CATEGORY and floor each one before rolling up to the
    month — so the trend month value equals the summed category breakdown for that same
    month in every over-refund case (ADR-160/162). ARS only: the trend is
    ARS-equivalent (ADR-025).
    """
    year = func.extract("year", TransactionRecord.occurred_on)
    month = func.extract("month", TransactionRecord.occurred_on)
    statement = (
        select(
            year.label("year"),
            month.label("month"),
            _CATEGORY.label("category"),
            _EXPENSE_AMOUNT.label("total"),
        )
        .where(
            TransactionRecord.user_id == owner,
            TransactionRecord.kind == Kind.EXPENSE.value,
            TransactionRecord.occurred_on >= oldest,
            TransactionRecord.occurred_on < upper,
        )
        .group_by(year, month, _CATEGORY)
    )
    result = await session.execute(statement)
    totals: dict[str, dict[str, Decimal]] = {}
    for row in result.all():
        key = f"{int(row.year):04d}-{int(row.month):02d}"
        totals.setdefault(key, {})[str(row.category)] = _as_decimal(row.total)
    return totals


async def _range_month_category_reimbursement_totals(
    session: AsyncSession,
    oldest: date,
    upper: date,
    owner: UUID,
) -> dict[str, dict[str, Decimal]]:
    """Return ARS reimbursement reductions keyed by ``YYYY-MM`` then LINKED EXPENSE category (ADR-159, ADR-160).

    The trend-window counterpart of :func:`month_category_reimbursement_totals`: for
    every ``kind='reimbursement'`` payback whose LINKED EXPENSE falls in the half-open
    ``[oldest, upper)`` range, sums the payback ``amount`` grouped by the EXPENSE'S
    ``(year, month, category)`` — never the payback's own date (ADR-159). Grouping by
    category (mirroring the gross side) is what lets the trend floor the over-refund PER
    CATEGORY, so the trend month value matches the summed category breakdown for that
    month (ADR-160/162). ARS only: the trend is ARS-equivalent (ADR-025).
    """
    linked_expense = aliased(TransactionRecord, name="trend_linked_expense")
    reimbursement = aliased(TransactionRecord, name="trend_reimbursement")
    year = func.extract("year", linked_expense.occurred_on)
    month = func.extract("month", linked_expense.occurred_on)
    category = func.coalesce(linked_expense.category, UNCATEGORIZED)
    reduction = cast(func.sum(reimbursement.amount), Numeric(18, 2))
    statement = (
        select(
            year.label("year"),
            month.label("month"),
            category.label("category"),
            reduction.label("reduction"),
        )
        .select_from(reimbursement)
        .join(linked_expense, reimbursement.offsets_transaction_id == linked_expense.id)
        .where(
            linked_expense.user_id == owner,
            linked_expense.kind == Kind.EXPENSE.value,
            linked_expense.occurred_on >= oldest,
            linked_expense.occurred_on < upper,
            reimbursement.kind == Kind.REIMBURSEMENT.value,
        )
        .group_by(year, month, category)
    )
    result = await session.execute(statement)
    totals: dict[str, dict[str, Decimal]] = {}
    for row in result.all():
        key = f"{int(row.year):04d}-{int(row.month):02d}"
        totals.setdefault(key, {})[str(row.category)] = _as_decimal(row.reduction)
    return totals


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

    async def monthly_summary(self, month: date, user_id: str) -> MonthlySummary:
        """Aggregate the 6-month trend and the month's category breakdown (ADR-108)."""
        owner = UUID(user_id)
        window = trend_window(month)
        prior = window[-2]
        requested = window[-1]

        trend_totals = await self._trend_totals(window[0], requested, owner)
        month_category_totals = await self._category_totals(requested, owner)
        prior_category_totals = await self._category_totals(prior, owner)

        return build_monthly_summary(
            month,
            trend_totals=trend_totals,
            month_category_totals=month_category_totals,
            prior_category_totals=prior_category_totals,
        )

    async def _trend_totals(self, oldest: date, newest: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's NET expense totals keyed by ``YYYY-MM`` across the trend window (ADR-160).

        Groups expenses by ``(year, month, category)`` over the inclusive range from the
        first day of ``oldest`` to the last day of ``newest``, scoped to ``owner``
        (ADR-108), then SUBTRACTS the linked reimbursements attributed to each expense's
        ``(month, category)`` (ADR-159/160). The netting and the ADR-162 over-refund floor
        are applied PER CATEGORY before rolling each month up to a single total — mirroring
        :func:`month_category_expense_totals` — so the trend month value equals the summed
        category breakdown for that same month in every over-refund case (one aggregation,
        four surfaces, all net; ADR-125/160/162). Flooring per month instead of per
        category would silently swallow real spend in a sibling category when one category
        is over-refunded, contradicting the category breakdown for the same month.
        """
        upper = date(newest.year + (newest.month // 12), (newest.month % 12) + 1, 1)
        gross = await _range_month_category_gross_expense_totals(self.session, oldest, upper, owner)
        reductions = await _range_month_category_reimbursement_totals(self.session, oldest, upper, owner)
        months = set(gross) | set(reductions)
        net: dict[str, Decimal] = {}
        for month_key in months:
            month_gross = gross.get(month_key, {})
            month_reductions = reductions.get(month_key, {})
            month_total = _ZERO
            categories = set(month_gross) | set(month_reductions)
            for category in categories:
                remaining = month_gross.get(category, _ZERO) - month_reductions.get(category, _ZERO)
                if remaining > _ZERO:
                    month_total += remaining
            net[month_key] = month_total
        return net

    async def _category_totals(self, month: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's expense totals for the month keyed by category (ADR-108).

        Delegates to the shared :func:`month_category_expense_totals` so the
        summaries category breakdown, the insights movers and the budgets "spent"
        all read the same per-category month-expense aggregation (ADR-042, ADR-125).
        """
        return await month_category_expense_totals(self.session, month, owner)


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

    async def monthly_insights(self, month: date, reference: date, user_id: str) -> MonthlyInsights:
        """Aggregate the structured insight facts for a month (ADR-060, ADR-061, ADR-108)."""
        owner = UUID(user_id)
        prior = date(month.year - 1, 12, 1) if month.month == 1 else date(month.year, month.month - 1, 1)

        month_category_totals = await self._expense_category_totals(month, owner)
        prior_category_totals = await self._expense_category_totals(prior, owner)
        recurring_count, recurring_total = await self._recurring_expenses(month, owner)
        income_total = await self._inflow_total(month, owner)
        expense_total = await self._expense_total(month, owner)
        latest_usd_invoice = await self._latest_usd_invoice(month, owner)

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

    async def _expense_category_totals(self, month: date, owner: UUID) -> dict[str, Decimal]:
        """Return the owner's NET expense totals for the month keyed by category (mover input, ADR-108, ADR-160).

        Delegates to the shared :func:`month_category_expense_totals` so the insights
        category mover reads the SAME net-of-reimbursements aggregation as the budgets
        "spent", the summaries breakdown and the history trend — one aggregation, four
        surfaces, all net (ADR-125, ADR-160).
        """
        return await month_category_expense_totals(self.session, month, owner)

    async def _recurring_expenses(self, month: date, owner: UUID) -> tuple[int, Decimal]:
        """Return the count and ARS-equivalent total of the owner's recurring expenses (ADR-108)."""
        statement = select(
            func.count().label("recurring_count"),
            cast(func.coalesce(func.sum(TransactionRecord.amount), _ZERO), Numeric(18, 2)).label("recurring_total"),
        ).where(
            TransactionRecord.user_id == owner,
            *_RECURRING_EXPENSE,
            TransactionRecord.occurred_on >= month,
            TransactionRecord.occurred_on < _month_upper_bound(month),
        )
        row = (await self.session.execute(statement)).one()
        return int(row.recurring_count), _as_decimal(row.recurring_total)

    async def _inflow_total(self, month: date, owner: UUID) -> Decimal:
        """SUM the owner's ARS-equivalent income for the month, plus any over-refund excess (ADR-108, ADR-162).

        Ordinary income is the inflow kinds (``income`` + ``invoice``) only — a
        ``reimbursement`` is NEVER ordinary income (ADR-158), so it is excluded here by
        the ``_INFLOW_KINDS`` filter. But when linked paybacks for a category-month
        EXCEED the gross expense (an over-refund), the category spend floors at zero and
        the EXCESS surfaces as ordinary income (ADR-162). The excess is attributed to the
        LINKED EXPENSE's category-month — the same period the floor removed it from — so
        money is conserved across the spend and income books for that month.
        """
        statement = select(cast(func.sum(TransactionRecord.amount), Numeric(18, 2))).where(
            TransactionRecord.user_id == owner,
            TransactionRecord.kind.in_(_INFLOW_KINDS),
            TransactionRecord.occurred_on >= month,
            TransactionRecord.occurred_on < _month_upper_bound(month),
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        base = _ZERO if total is None else _as_decimal(total)
        return base + await self._over_refund_excess(month, owner)

    async def _over_refund_excess(self, month: date, owner: UUID) -> Decimal:
        """Return the month's over-refund excess to credit as income (ADR-162).

        For each category whose linked reimbursements exceed its gross ARS expense in
        the month, the excess is ``reduction - gross`` (never negative). Summed across
        categories, this is the amount the category-spend floor dropped to zero and which
        ADR-162 routes to ordinary income. Computed on the authoritative ARS ``amount``
        (income is ARS-equivalent, ADR-025), keyed by the LINKED EXPENSE's category-month
        so it lines up with the floor that produced it.
        """
        gross = await _month_category_gross_expense_totals(self.session, month, owner, is_usd=False)
        reductions = await month_category_reimbursement_totals(self.session, month, owner)
        excess = _ZERO
        for category, reduction in reductions.items():
            over = reduction - gross.get(category, _ZERO)
            if over > _ZERO:
                excess += over
        return excess

    async def _expense_total(self, month: date, owner: UUID) -> Decimal:
        """SUM the owner's NET ARS-equivalent expense for the month (savings input, ADR-108, ADR-160).

        Net of linked reimbursements (ADR-160): reuses the shared
        :func:`month_category_expense_totals` (each category floored at zero, ADR-162)
        and sums its values so the savings projection's expense leg matches the budgets/
        summaries/insights net spend — one aggregation, four surfaces (ADR-125).
        """
        net = await month_category_expense_totals(self.session, month, owner)
        return sum(net.values(), _ZERO)

    async def _latest_usd_invoice(self, month: date, owner: UUID) -> LatestUsdInvoice | None:
        """Return the month's most recent USD INVOICE with an applied rate.

        Only ``invoice``-kind rows qualify — the insight is "latest invoice", so a
        USD expense (e.g. a fee paid in dollars) must not surface here (it would
        read as a positive invoice, ADR-060). The row must be in USD and carry both
        a ``usd_amount`` and an ``fx_rate``. Ordered newest-first by ``occurred_on``
        (``created_at`` as a stable tiebreak) and limited to one. Scoped to the
        ``owner`` so a foreign user's invoice never surfaces (ADR-108).
        """
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.user_id == owner,
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

    async def snapshot(self, reference: date, user_id: str) -> MonotributoSnapshot:
        """Assemble the owner's current standing, previous standing and drilldown (ADR-112)."""
        owner = UUID(user_id)
        current = await self._current_standing(reference, owner)
        invoices = await self._invoices_in_window(current.period_start, current.period_end, owner)
        previous = await self._previous_standing(reference, owner)
        return build_snapshot(current=current, previous=previous, invoices=invoices)

    async def current_standing(self, reference: date, user_id: str) -> MonotributoStanding:
        """Compute the owner's live trailing-12-month standing (ADR-046, ADR-112)."""
        return await self._current_standing(reference, UUID(user_id))

    async def _current_standing(self, reference: date, owner: UUID) -> MonotributoStanding:
        """Compute the live trailing-12-month standing for an already-coerced ``owner``."""
        window_start, window_end = trailing_window(reference)
        # The AFIP scale (category ceilings) is shared reference data; only the
        # configured category and used income are user-scoped (ADR-112).
        category, activity_type = await self._configured_category(owner)
        used = await self._used_in_window(window_start, window_end, owner)
        return build_standing(
            used=used,
            category=category,
            activity_type=activity_type,
            window_start=window_start,
            window_end=window_end,
            reference=reference,
        )

    async def _previous_standing(self, reference: date, owner: UUID) -> MonotributoStanding | None:
        """Resolve the owner's prior-window standing from a snapshot, else compute it.

        Reads the owner's persisted snapshot for the prior window's ``period_end``
        when one exists (frozen historical figures, ADR-052); otherwise computes the
        prior window live from the owner's transactions so the comparison still has
        data on first read.
        """
        prior_start, prior_end = prior_window(reference)
        persisted = await self._snapshot_at(prior_end, owner)
        if persisted is not None:
            return persisted
        category, activity_type = await self._configured_category(owner)
        used = await self._used_in_window(prior_start, prior_end, owner)
        return build_standing(
            used=used,
            category=category,
            activity_type=activity_type,
            window_start=prior_start,
            window_end=prior_end,
            reference=prior_end,
        )

    async def _configured_category(self, owner: UUID) -> tuple[str, str]:
        """Return the owner's ``(category, activity_type)`` from ``app_settings`` (ADR-054, ADR-112).

        The Monotributo category lives in the per-user ``app_settings`` row
        (ADR-054, superseding the retired ``monotributo_config``); scoped to
        ``owner`` (ADR-108) and falling back to the documented settings defaults
        when no row exists yet.
        """
        statement = (
            select(
                AppSettingsRecord.monotributo_current_category,
                AppSettingsRecord.monotributo_activity_type,
            )
            .where(AppSettingsRecord.user_id == owner)
            .limit(1)
        )
        row = (await self.session.execute(statement)).first()
        if row is None:
            return DEFAULT_MONOTRIBUTO_CATEGORY, DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE
        return str(row.monotributo_current_category), str(row.monotributo_activity_type)

    async def _used_in_window(self, window_start: date, window_end: date, owner: UUID) -> Decimal:
        """SUM the owner's included income over the inclusive ``[start, end]`` window (ADR-108)."""
        statement = select(_INCLUDED_AMOUNT).where(
            TransactionRecord.user_id == owner,
            *_COUNTS_TOWARD_LIMIT,
            TransactionRecord.occurred_on >= window_start,
            TransactionRecord.occurred_on <= window_end,
        )
        total = (await self.session.execute(statement)).scalar_one_or_none()
        return _ZERO if total is None else _as_decimal(total)

    async def _invoices_in_window(self, window_start: date, window_end: date, owner: UUID) -> list[MonotributoInvoice]:
        """List the owner's counted invoices oldest-first with a running cumulative (ADR-108)."""
        statement = (
            select(TransactionRecord)
            .where(
                TransactionRecord.user_id == owner,
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

    async def _snapshot_at(self, period_end: date, owner: UUID) -> MonotributoStanding | None:
        """Read the owner's persisted standing for a ``period_end`` month, or ``None`` (ADR-108)."""
        statement = (
            select(MonotributoSnapshotRecord)
            .where(
                MonotributoSnapshotRecord.user_id == owner,
                MonotributoSnapshotRecord.period_end == period_end,
            )
            .limit(1)
        )
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
    """Serve the per-user application settings from ``app_settings`` (ADR-054, ADR-110).

    Runs a read-only query over the owner's ``app_settings`` row and projects it
    into an :class:`AppSettings` read model. When the owner has no row yet it
    returns the documented defaults (ARS / MEP / category ``C`` / services) so the
    query side never returns ``None``. It never mutates state -- settings writes
    are a separate command on the unit of work (ADR-054), which get-or-creates the
    owner's row (ADR-110).
    """

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the reader.

        Args:
            session: The async session used for read-only queries.
        """
        self.session = session

    async def get_settings(self, user_id: str) -> AppSettings:
        """Return the owner's settings, or the documented defaults when absent (ADR-110)."""
        statement = select(AppSettingsRecord).where(AppSettingsRecord.user_id == UUID(user_id)).limit(1)
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return AppSettings(
                preferred_display_currency=DEFAULT_DISPLAY_CURRENCY,
                fx_default_rate_type=DEFAULT_FX_RATE_TYPE,
                preferred_rate_source=DEFAULT_PREFERRED_RATE_SOURCE,
                monotributo_current_category=DEFAULT_MONOTRIBUTO_CATEGORY,
                monotributo_activity_type=DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE,
                monotributo_enabled=DEFAULT_MONOTRIBUTO_ENABLED,
            )
        return AppSettings(
            preferred_display_currency=record.preferred_display_currency,
            fx_default_rate_type=record.fx_default_rate_type,
            preferred_rate_source=record.preferred_rate_source,
            monotributo_current_category=record.monotributo_current_category,
            monotributo_activity_type=record.monotributo_activity_type,
            monotributo_enabled=record.monotributo_enabled,
        )
