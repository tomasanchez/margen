"""Pure assembly of the net-worth history series from raw aggregates (ADR-164).

The SQLAlchemy adapter runs the per-currency aggregation — the opening-balance
totals and the per-month incremental signed flow (transaction deltas + net
transfer flow) — and hands the raw figures to these pure functions, which roll
the increments up into the cumulative month-END subtotals per currency. Keeping
this logic free of I/O makes it fast to unit test (ADR-131) and keeps SQLAlchemy
in the adapter (AGENTS.md).

Net-worth history is per-currency NATIVE (ADR-164): no FX conversion happens here
or in the adapter. Each month's cumulative ARS/USD subtotal is
``opening_balance + Σ signed flow up to and including that month``, exactly the
signed-delta + transfer-flow model the current snapshot uses (ADR-122/123/135),
accumulated over time rather than collapsed to a single point.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.reports_read_models import NetWorthHistory, NetWorthHistoryPoint

# The default and maximum history window in calendar months (ADR-164). The window
# ends at the current month; a request for more than a year of history is clamped
# so an arbitrarily large ``months`` cannot force an unbounded series.
DEFAULT_MONTHS = 12
MAX_MONTHS = 60
MIN_MONTHS = 1
_ZERO = Decimal(0)
# Money is presented to 2 decimal places (ADR-025); the running cumulative is
# quantized to cents so an empty axis reads ``0.00`` and any driver-widened SUM
# collapses back to money precision.
_CENTS = Decimal("0.01")


def _money(value: Decimal) -> Decimal:
    """Round a monetary value to 2 decimal places, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def clamp_months(months: int) -> int:
    """Clamp a requested window to ``[MIN_MONTHS, MAX_MONTHS]`` (ADR-164).

    Args:
        months: The caller's requested number of months.

    Returns:
        The requested value bounded to the supported window so the series is never
        empty and never unbounded.
    """
    return max(MIN_MONTHS, min(months, MAX_MONTHS))


def month_key(value: date) -> str:
    """Render a calendar month as ``YYYY-MM`` (the API's month identity)."""
    return f"{value.year:04d}-{value.month:02d}"


def add_months(value: date, delta: int) -> date:
    """Return the first day of the month ``delta`` calendar months from ``value``.

    Args:
        value: Any date; only its year and month matter.
        delta: Signed number of months to add (may be negative).

    Returns:
        The first day of the resulting month.
    """
    index = value.year * 12 + (value.month - 1) + delta
    year, month = divmod(index, 12)
    return date(year, month + 1, 1)


def history_window(reference: date, months: int) -> list[date]:
    """Return the first days of the ``months`` months ending at ``reference``, oldest-first.

    Args:
        reference: Any date within the newest month of the window.
        months: The (already clamped) number of months to cover.

    Returns:
        The first days of each month in the window, oldest-first, ending at the
        month containing ``reference``.
    """
    return [add_months(reference, offset) for offset in range(-(months - 1), 1)]


def build_net_worth_history(
    reference: date,
    months: int,
    *,
    opening_by_currency: Mapping[Currency, Decimal],
    monthly_flow_by_currency: Mapping[Currency, Mapping[str, Decimal]],
) -> NetWorthHistory:
    """Assemble the cumulative month-END net-worth history series (ADR-164).

    Rolls the per-month incremental signed flow up into a running cumulative total
    per currency, starting from the opening-balance total. Every account's opening
    balance is counted from the FIRST point of the window, so the earliest month is
    ``opening + flow within/before that month`` — a balance carried into the window
    is reflected, not lost. Months with no movement carry the prior month's
    cumulative unchanged.

    Args:
        reference: Any date within the newest month of the window.
        months: The clamped number of months to cover.
        opening_by_currency: The SUM of every account's ``opening_balance`` keyed by
            the account's currency (native, ADR-123).
        monthly_flow_by_currency: The incremental signed flow (transaction deltas +
            net transfer flow) keyed by currency then by ``YYYY-MM``. Flow that
            occurred BEFORE the window's first month is folded into the first
            month's key by the adapter so it is included in the opening cumulative.

    Returns:
        The assembled :class:`NetWorthHistory`, oldest-first, each point carrying
        the cumulative native ARS and USD subtotals at that month-end.
    """
    window = history_window(reference, months)
    running = {
        Currency.ARS: opening_by_currency.get(Currency.ARS, _ZERO),
        Currency.USD: opening_by_currency.get(Currency.USD, _ZERO),
    }
    ars_flow = monthly_flow_by_currency.get(Currency.ARS, {})
    usd_flow = monthly_flow_by_currency.get(Currency.USD, {})
    points: list[NetWorthHistoryPoint] = []
    for first_of_month in window:
        key = month_key(first_of_month)
        running[Currency.ARS] += ars_flow.get(key, _ZERO)
        running[Currency.USD] += usd_flow.get(key, _ZERO)
        points.append(
            NetWorthHistoryPoint(
                month=key,
                ars_total=_money(running[Currency.ARS]),
                usd_total=_money(running[Currency.USD]),
            )
        )
    return NetWorthHistory(months=points)
