"""Pure assembly of the schedule/commitment-driven cash-flow forecast (ADR-176, ADR-177).

The SQLAlchemy adapter runs the per-stream aggregations — the latest observed amount
and last-actual month of each flagged recurring expense stream, and each instalment
plan's cuota amount, remaining count and last-actual month — and hands the raw,
already-denominated figures to these pure, I/O-free functions (like
:mod:`reports_overview`), which:

* build the forward horizon of month-start dates starting the month AFTER the current
  month (ADR-176), clamped to ``1..12`` months (default ``6``);
* project each flagged recurring stream's latest observed amount on its cadence
  (monthly / quarterly / annual) across the horizon, but ONLY into months strictly
  after the stream's latest actual occurrence — actuals own the past, projection owns
  the future, so a stream is never double-counted with its own history (ADR-176);
* project each instalment plan's cuota for its remaining payments
  (``installments_total - installments_index``) on a monthly cadence starting the
  month after the plan's last actual occurrence, capped at the horizon (ADR-176);
* add the configured monotributo monthly cuota as a committed AFIP-ARS tax outflow in
  every horizon month (ADR-177) — always denominated ARS with ``ars_fixed=True``, summed
  into the month total ONLY on an ARS request (it is never re-denominated into a USD
  total, nor counted as ``unconverted``); and
* sum the per-month committed total and emit the ``commitments`` breakdown for the UI.

All money is denominated in the requested currency by the adapter (ADR-168): it sums
the authoritative ``amount`` for ARS and the materialized ``usd_amount`` snapshot for
USD, excluding null-snapshot rows and surfacing the excluded count as ``unconverted``
(ADR-152). Keeping the horizon math and assembly here keeps SQLAlchemy in the adapter
(AGENTS.md). Money is :class:`~decimal.Decimal` throughout (ADR-025). ``add_months`` /
``month_key`` are reused from :mod:`summaries` (the same month identity the rest of the
API speaks).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from margen_api.domain.models.value_objects import RecurringCadence
from margen_api.service_layer.forecast_read_models import (
    CommitmentLine,
    CommitmentSource,
    ForecastMonth,
    ForecastSeries,
)
from margen_api.service_layer.summaries import add_months, month_key

# Horizon bounds (ADR-176): a forward window of committed outflows, defaulting to 6
# months and clamped to a sensible 1..12 so a query never projects an unbounded tail.
DEFAULT_HORIZON = 6
MIN_HORIZON = 1
MAX_HORIZON = 12

# Cadence period in calendar months. ``installment`` is projected monthly by its own
# tail logic (not by this map), so only the subscription-style cadences appear here.
_CADENCE_MONTHS: dict[RecurringCadence, int] = {
    RecurringCadence.MONTHLY: 1,
    RecurringCadence.QUARTERLY: 3,
    RecurringCadence.ANNUAL: 12,
}

# v1 confidence: every projected month is entirely committed outflows — there is no
# discretionary band yet (ADR-176), so the whole series is 'committed'.
CONFIDENCE_COMMITTED = "committed"

_ZERO = Decimal(0)
_CENTS = Decimal("0.01")

# The monotributo commitment's stable label (ADR-177); the frontend localizes it.
MONOTRIBUTO_LABEL = "Monotributo"

# The requested-currency token that shares the monotributo cuota's AFIP-ARS
# denomination — the only currency the cuota may be summed into a month total (ADR-177).
CURRENCY_ARS = "ARS"


def clamp_horizon(horizon: int) -> int:
    """Clamp a requested horizon into the supported ``1..12`` month window (ADR-176)."""
    return max(MIN_HORIZON, min(MAX_HORIZON, horizon))


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def horizon_window(reference: date, horizon: int) -> list[date]:
    """Return the ``horizon`` month-start dates AFTER ``reference``'s month, oldest-first.

    The forecast projects the FUTURE, so the window begins the month after the current
    month and runs forward ``horizon`` months (ADR-176). Only the year/month of
    ``reference`` matter.

    Args:
        reference: The reference date (server "today"); its year/month anchor the start.
        horizon: The number of forward months (already clamped by the caller).

    Returns:
        The forward month-start dates, oldest-first, none of them in the current or a
        past month.
    """
    first = add_months(date(reference.year, reference.month, 1), 1)
    return [add_months(first, offset) for offset in range(horizon)]


@dataclass(frozen=True, slots=True)
class RecurringStream:
    """A flagged recurring expense stream's projection inputs (ADR-176).

    The adapter derives one of these per recurring expense stream from the LATEST
    observed occurrence: its label, its latest observed amount (already denominated in
    the requested currency, or ``None`` when the USD snapshot is missing), its cadence,
    and the month of its latest actual occurrence (so projection covers only months
    strictly after it — no double-count, ADR-176).

    Attributes:
        label: The stream's display label (the transaction name).
        amount: The latest observed amount in the requested currency, or ``None`` when
            a USD denomination excluded it for lacking a snapshot (ADR-152).
        cadence: The stream's cadence; a stream with no explicit cadence defaults to
            monthly (ADR-176), resolved by the adapter before handing it here.
        last_actual_month: The ``YYYY-MM`` of the stream's latest actual occurrence.
    """

    label: str
    amount: Decimal | None
    cadence: RecurringCadence
    last_actual_month: str


@dataclass(frozen=True, slots=True)
class InstallmentStream:
    """An instalment plan's tail projection inputs (ADR-176).

    The adapter derives one of these per instalment plan from its latest actual
    occurrence: its label, the cuota amount (already denominated), the remaining
    payment count (``installments_total - installments_index``) and the month of its
    latest actual occurrence (projection starts the month after it, ADR-176).

    Attributes:
        label: The plan's display label (the transaction name).
        amount: The per-cuota amount in the requested currency, or ``None`` when a USD
            denomination excluded it for lacking a snapshot (ADR-152).
        remaining_count: The number of payments still to come after the latest actual
            occurrence (``installments_total - installments_index``); ``0`` when the
            plan is already paid off.
        last_actual_month: The ``YYYY-MM`` of the plan's latest actual occurrence.
    """

    label: str
    amount: Decimal | None
    remaining_count: int
    last_actual_month: str


def _cadence_months(window: list[date], stream: RecurringStream) -> list[str]:
    """Return the horizon months a recurring stream lands a payment in (ADR-176).

    A payment lands on the stream's cadence measured from its latest actual month, and
    only in horizon months STRICTLY AFTER that latest actual (actuals own the past,
    projection owns the future — no double-count, ADR-176). For a monthly cadence every
    horizon month qualifies; for quarterly/annual only the months whose offset from the
    last actual is a positive multiple of the cadence period do.

    Args:
        window: The horizon month-start dates, oldest-first.
        stream: The recurring stream whose cadence and last-actual month drive the hits.

    Returns:
        The ``YYYY-MM`` months (oldest-first) the stream lands a payment in.
    """
    period = _CADENCE_MONTHS[stream.cadence]
    last_actual = stream.last_actual_month
    hits: list[str] = []
    for month in window:
        key = month_key(month)
        offset = _month_offset(last_actual, key)
        if offset > 0 and offset % period == 0:
            hits.append(key)
    return hits


def _month_offset(from_key: str, to_key: str) -> int:
    """Return the signed number of calendar months from ``from_key`` to ``to_key``.

    Both are ``YYYY-MM`` keys. A positive result means ``to_key`` is later; the forecast
    only ever projects into strictly-later months (offset > 0), so this is the "how far
    after the last actual" measure that drives cadence hits (ADR-176).
    """
    from_year, from_month = (int(part) for part in from_key.split("-"))
    to_year, to_month = (int(part) for part in to_key.split("-"))
    return (to_year * 12 + (to_month - 1)) - (from_year * 12 + (from_month - 1))


def _installment_months(window: list[date], stream: InstallmentStream) -> list[str]:
    """Return the horizon months an instalment tail lands a payment in (ADR-176).

    The tail runs monthly starting the month AFTER the plan's latest actual, for its
    remaining payment count, capped by the horizon. Only months strictly after the last
    actual qualify (no double-count with the actual instalments already recorded).

    Args:
        window: The horizon month-start dates, oldest-first.
        stream: The instalment plan whose remaining count and last-actual month drive
            the tail.

    Returns:
        The ``YYYY-MM`` months (oldest-first) the remaining cuotas land in.
    """
    if stream.remaining_count <= 0:
        return []
    last_actual = stream.last_actual_month
    hits: list[str] = []
    for month in window:
        key = month_key(month)
        offset = _month_offset(last_actual, key)
        # The nth remaining payment lands offset==n (n = 1..remaining_count).
        if 1 <= offset <= stream.remaining_count:
            hits.append(key)
    return hits


def build_forecast(
    reference: date,
    horizon: int,
    currency: str,
    *,
    recurring_streams: list[RecurringStream],
    installment_streams: list[InstallmentStream],
    monotributo_cuota: Decimal | None,
    unconverted: int,
) -> ForecastSeries:
    """Assemble the full committed-outflow forecast from the raw stream inputs (ADR-176, ADR-177).

    Composes the forward horizon (starting the month AFTER the current month, ADR-176),
    projects each recurring stream on its cadence and each instalment plan's remaining
    tail (both only into months strictly after their latest actual — no double-count),
    adds the monotributo monthly cuota commitment in every horizon month (ADR-177), and
    sums the per-month committed total. A stream whose denominated amount is ``None`` (a
    USD row lacking a snapshot, ADR-152) is skipped from the sums but the exclusion is
    already reflected in ``unconverted``.

    The monotributo cuota is always an AFIP-fixed ARS figure (ADR-177): its commitment
    line is always ``currency="ARS"`` with ``ars_fixed=True`` regardless of the requested
    currency, and it is added into the month total ONLY when ``currency == "ARS"`` (same
    denomination). On a USD request it is NOT summed into the USD total (it can't be
    re-denominated) and never increments ``unconverted`` — it still appears as its own ARS
    commitment line so the frontend can surface it separately.

    Args:
        reference: The reference date (server "today"); its month anchors the horizon.
        horizon: The requested horizon in months (clamped ``1..12`` by the caller).
        currency: The requested denomination currency (``ARS`` / ``USD``), echoed back.
        recurring_streams: The flagged recurring expense streams to project.
        installment_streams: The instalment plans whose tails to project.
        monotributo_cuota: The configured monotributo monthly cuota as an AFIP-fixed ARS
            amount (ADR-177), or ``None`` when monotributo is not configured / not
            applicable. Always ARS regardless of the requested ``currency``.
        unconverted: Count of committed rows excluded from a USD denomination for
            lacking a snapshot; always ``0`` on the ARS path (ADR-152).

    Returns:
        The assembled :class:`ForecastSeries`.
    """
    window = horizon_window(reference, horizon)
    month_keys = [month_key(month) for month in window]
    totals: dict[str, Decimal] = dict.fromkeys(month_keys, _ZERO)
    commitments: list[CommitmentLine] = []

    for stream in recurring_streams:
        hits = _cadence_months(window, stream)
        if not hits or stream.amount is None:
            continue
        amount = _money(stream.amount)
        for key in hits:
            totals[key] += amount
        commitments.append(
            CommitmentLine(
                source=CommitmentSource.SUBSCRIPTION,
                label=stream.label,
                amount=amount,
                currency=currency,
                months=hits,
            )
        )

    for stream in installment_streams:
        hits = _installment_months(window, stream)
        if not hits or stream.amount is None:
            continue
        amount = _money(stream.amount)
        for key in hits:
            totals[key] += amount
        commitments.append(
            CommitmentLine(
                source=CommitmentSource.INSTALLMENT,
                label=stream.label,
                amount=amount,
                currency=currency,
                months=hits,
                remaining_count=stream.remaining_count,
            )
        )

    if monotributo_cuota is not None and monotributo_cuota > _ZERO:
        cuota = _money(monotributo_cuota)
        # The cuota is an AFIP-fixed ARS liability — always denominated ARS and never
        # re-denominated to USD (ADR-177). It joins the month total only when the
        # request is in the SAME denomination (ARS); on a USD request it can't be summed
        # into the USD total without re-denominating (forbidden), so it is surfaced only
        # as its own ARS commitment line for the frontend to render separately. It never
        # touches ``unconverted`` — it is a known fixed ARS figure, not a missing snapshot.
        if currency == CURRENCY_ARS:
            for key in month_keys:
                totals[key] += cuota
        commitments.append(
            CommitmentLine(
                source=CommitmentSource.TAX,
                label=MONOTRIBUTO_LABEL,
                amount=cuota,
                currency=CURRENCY_ARS,
                months=list(month_keys),
                ars_fixed=True,
            )
        )

    months = [
        ForecastMonth(
            month=key,
            committed=_money(totals[key]),
            total=_money(totals[key]),
            confidence=CONFIDENCE_COMMITTED,
        )
        for key in month_keys
    ]
    return ForecastSeries(
        horizon=horizon,
        currency=currency,
        months=months,
        commitments=commitments,
        unconverted=unconverted,
    )
