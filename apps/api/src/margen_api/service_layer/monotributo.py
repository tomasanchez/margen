"""Pure Monotributo business logic (ADR-046, ADR-052).

The SQLAlchemy adapter sums the included invoices and reads the config; these
pure, I/O-free functions turn the raw ``used`` total into a trailing-12-month
standing: the status band, the linear-annualization projection, the margin /
percent math, and the assembly of the full page snapshot. Keeping the logic free
of I/O makes it fast to unit test (ADR-050) and keeps SQLAlchemy in the adapter
(AGENTS.md). Money is :class:`~decimal.Decimal` throughout (ADR-025).
"""

from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from margen_api.domain.models.monotributo_scale import (
    get_category,
    get_ceiling,
    next_scale_review,
    scale_for,
    smallest_category_for,
)
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoRecommendation,
    MonotributoScaleEntry,
    MonotributoSnapshot,
    MonotributoStanding,
)
from margen_api.service_layer.summaries import add_months

# Defaults used until a config row is persisted (the PATCH config endpoint is a
# separate task). Category A is the smallest band; services is the MVP activity
# (ADR-046, ADR-048).
DEFAULT_CATEGORY = "A"
DEFAULT_ACTIVITY_TYPE = "services"

# Status band thresholds as a percentage of the annual ceiling (ADR-046).
_WATCH_THRESHOLD = Decimal(70)
_CLOSE_THRESHOLD = Decimal(90)
_OVER_THRESHOLD = Decimal(100)

_ZERO = Decimal(0)
_HUNDRED = Decimal(100)
_TWELVE = Decimal(12)
# Money and the effective-rate percentage round to two decimals, half-up (ADR-025).
_CENTS = Decimal("0.01")

# Which cuota column applies per taxpayer activity type. Anything other than the
# services MVP path reads the goods cuota (ADR-046).
_SERVICES_ACTIVITY = "services"

# Calm, plain-language copy per status band (ADR-046).
_STATUS_COPY: dict[str, str] = {
    "safe": "On track",
    "watch": "Keep an eye on this",
    "close": "Close to your limit",
    "over": "Over your limit",
}

# Days in the trailing window used to gauge how much of the period has elapsed
# with data for the linear-annualization projection.
_WINDOW_DAYS = Decimal(365)
# Below this fraction of the window the projection is flagged low-confidence
# (early months / first period) so the UI can soften the estimate (ADR-046).
_LOW_CONFIDENCE_FRACTION = Decimal("0.25")


def month_start(value: date) -> date:
    """Return the first day of ``value``'s calendar month.

    Snapshot history is month-granular (ADR-052): standings are keyed by the
    first day of the ``period_end`` month so concurrent reads in the same month
    converge to a single row and backfilled months line up with the prior-window
    lookup.
    """
    return value.replace(day=1)


def trailing_window(reference: date) -> tuple[date, date]:
    """Return the trailing-12-month window ending at ``reference`` (ADR-046).

    Args:
        reference: The reference date (typically server "today").

    Returns:
        A ``(period_start, period_end)`` tuple where ``period_end`` is
        ``reference`` and ``period_start`` is the first day of the month 12 months
        earlier (an inclusive ~12-month window).
    """
    return add_months(reference, -12), reference


def prior_window(reference: date) -> tuple[date, date]:
    """Return the prior trailing-12-month window (ending 12 months ago) (ADR-052).

    The prior window ends at the first day of the month 12 months before
    ``reference`` — month-granular so it lines up with the keyed snapshot history.

    Args:
        reference: The current reference date (server "today").

    Returns:
        A ``(period_start, period_end)`` tuple for the window ending 12 months
        before ``reference`` — the comparison baseline.
    """
    prior_end = month_start(add_months(reference, -12))
    return trailing_window(prior_end)


def status_band(percent_used: Decimal) -> str:
    """Return the status band key for a percent-of-ceiling figure (ADR-046).

    Bands: ``safe`` (< 70%), ``watch`` (70-90%), ``close`` (90-100%), ``over``
    (> 100%).

    Args:
        percent_used: ``used / ceiling * 100``.

    Returns:
        One of ``"safe"``, ``"watch"``, ``"close"``, ``"over"``.
    """
    if percent_used > _OVER_THRESHOLD:
        return "over"
    if percent_used >= _CLOSE_THRESHOLD:
        return "close"
    if percent_used >= _WATCH_THRESHOLD:
        return "watch"
    return "safe"


def status_copy(band: str) -> str:
    """Return the calm display copy for a status band key (ADR-046)."""
    return _STATUS_COPY[band]


def _money(value: Decimal) -> Decimal:
    """Round a monetary or percentage value to two decimals, half-up (ADR-025)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def _percent_used(used: Decimal, ceiling: Decimal) -> Decimal:
    """Return ``used / ceiling * 100``, guarding a zero ceiling."""
    if ceiling == _ZERO:
        return _ZERO
    return used / ceiling * _HUNDRED


def _elapsed_fraction(window_start: date, reference: date) -> Decimal:
    """Return the fraction (0, 1] of the trailing window elapsed with data.

    The projection annualizes ``used`` by dividing by this fraction. Clamped to
    ``(0, 1]`` so a future reference date or a degenerate window cannot inflate or
    invert the estimate.
    """
    elapsed_days = Decimal((reference - window_start).days)
    if elapsed_days <= _ZERO:
        return _LOW_CONFIDENCE_FRACTION
    fraction = elapsed_days / _WINDOW_DAYS
    return min(fraction, Decimal(1))


def project(used: Decimal, *, window_start: date, reference: date) -> tuple[str, str]:
    """Linearly annualize ``used`` and return its projected category and note.

    The projection assumes a steady pace: ``annualized = used / fraction`` of the
    window elapsed with data, and the projected category is the smallest band whose
    ceiling covers the annualized figure (ADR-046). The note always labels this an
    estimate, and adds a low-confidence caveat when little of the window has
    elapsed (early months / first period).

    Args:
        used: The trailing-window included income so far.
        window_start: First day of the trailing window.
        reference: The reference date (server "today").

    Returns:
        A ``(projected_category, projection_note)`` pair.
    """
    fraction = _elapsed_fraction(window_start, reference)
    annualized = used / fraction
    # Resolve the projected band against the scale vintage in effect for this
    # standing's reference date (ADR-067): the live calc uses today's (current)
    # scale, a backfilled past period uses that period's vintage.
    projected_category = smallest_category_for(annualized, as_of=reference)
    note = "Estimate assuming you keep up your current pace."
    if fraction < _LOW_CONFIDENCE_FRACTION or used == _ZERO:
        note = "Rough estimate — there isn't much data yet, so this may change a lot."
    return projected_category, note


def build_standing(
    *,
    used: Decimal,
    category: str,
    activity_type: str,
    window_start: date,
    window_end: date,
    reference: date,
) -> MonotributoStanding:
    """Assemble a :class:`MonotributoStanding` from a raw ``used`` total (ADR-046).

    Args:
        used: SUM of the included invoices over the window.
        category: The configured category letter (A-K).
        activity_type: ``"services"`` or ``"bienes"``.
        window_start: First day of the trailing window.
        window_end: Last day of the trailing window.
        reference: The date the projection annualizes against (server "today").

    Returns:
        The assembled standing with ``remaining`` (``ceiling - used``),
        ``percent_used``, status band and projection filled in.
    """
    # Use the ceiling from the scale vintage in effect for this standing's
    # reference date (ADR-067): live standings (reference≈today) get the current
    # scale, ADR-052 backfilled past periods get the period's historical scale.
    ceiling = get_ceiling(category, as_of=reference)
    percent = _percent_used(used, ceiling)
    band = status_band(percent)
    projected_category, projection_note = project(used, window_start=window_start, reference=reference)
    return MonotributoStanding(
        category=category,
        activity_type=activity_type,
        limit=ceiling,
        used=used,
        remaining=ceiling - used,
        percent_used=percent,
        status=band,
        projected_category=projected_category,
        projection_note=projection_note,
        period_start=window_start,
        period_end=window_end,
    )


def recommend_category(
    avg_monthly_expenses: Decimal,
    *,
    activity_type: str,
    as_of: date,
) -> MonotributoRecommendation | None:
    """Recommend the cheapest category covering the owner's needed invoicing (owner-confirmed feature).

    Treats the trailing-3-month average expenses, annualized, as the income the
    taxpayer needs to invoice to cover a year at that pace, then picks the cheapest
    Monotributo band whose annual ceiling covers it and reports its cuota as the
    "cost" plus the effective tax rate against that invoicing. The scale vintage is
    resolved for ``as_of`` (ADR-067) so the calc stays clock-injected like the rest
    of the Monotributo code.

    Args:
        avg_monthly_expenses: The owner's trailing-3-calendar-month average net
            expense outflow (reimbursement-net, ARS-equivalent; ADR-025/158).
        activity_type: ``"services"`` (reads ``cuota_servicios``) or otherwise the
            goods path (reads ``cuota_bienes``); the standing's own activity type.
        as_of: The reference date selecting the scale vintage (server "today").

    Returns:
        A :class:`MonotributoRecommendation`, or ``None`` when there is no expense
        history (``avg_monthly_expenses`` is ``0``) so the UI shows a calm
        "add expenses to see this" note rather than a divide-by-zero figure.
    """
    if avg_monthly_expenses <= _ZERO:
        return None
    needed_annual_invoicing = _money(avg_monthly_expenses * _TWELVE)
    letter = smallest_category_for(needed_annual_invoicing, as_of=as_of)
    row = get_category(letter, as_of=as_of)
    monthly_fee = row.cuota_servicios if activity_type == _SERVICES_ACTIVITY else row.cuota_bienes
    annual_fee = _money(monthly_fee * _TWELVE)
    # needed_annual_invoicing is > 0 here (avg was > 0), so the rate never divides by
    # zero; still round it the money way for a stable contract (ADR-025).
    effective_tax_rate_pct = _money(annual_fee / needed_annual_invoicing * _HUNDRED)
    # smallest_category_for floors at the top band when the amount exceeds every
    # ceiling; flag that so the UI can say "beyond Monotributo — consider régimen
    # general" instead of implying the top band actually covers the invoicing.
    top_ceiling = scale_for(as_of).categories[-1].annual_ceiling
    above_scale = needed_annual_invoicing > top_ceiling
    return MonotributoRecommendation(
        avg_monthly_expenses=_money(avg_monthly_expenses),
        needed_annual_invoicing=needed_annual_invoicing,
        category=letter,
        monthly_fee=monthly_fee,
        annual_fee=annual_fee,
        effective_tax_rate_pct=effective_tax_rate_pct,
        above_scale=above_scale,
    )


def scale_entries(as_of: date | None = None) -> list[MonotributoScaleEntry]:
    """Return the A-K reference scale as read-model entries for the ``as_of`` vintage (ADR-048, ADR-067).

    Resolves the scale table by the SAME date the standing meter, projection and
    recommendation use (``as_of=reference``) so the page shows one consistent set of
    ceilings for every category — never a table on one vintage and a meter on another.
    ``None`` keeps the clock-free latest vintage for callers that do not date the page.

    Args:
        as_of: The reference date selecting the scale vintage; ``None`` uses the
            latest (current) vintage (ADR-067).
    """
    return [
        MonotributoScaleEntry(
            letter=row.letter,
            annual_ceiling=row.annual_ceiling,
            cuota_servicios=row.cuota_servicios,
            cuota_bienes=row.cuota_bienes,
        )
        for row in scale_for(as_of).categories
    ]


def build_snapshot(
    *,
    reference: date,
    current: MonotributoStanding,
    previous: MonotributoStanding | None,
    invoices: list[MonotributoInvoice],
) -> MonotributoSnapshot:
    """Assemble the full Monotributo page snapshot on ONE clock (ADR-052, ADR-067).

    Every dated part of the page — the standing meter, the projection, the
    recommendation AND the A-K reference table — resolves against ``reference`` so the
    whole page shows the same vintage (today the 2026-02 scale; on Aug 1 2026 the page
    auto-switches to 2026-08). The resolved vintage's ``effective_from`` and its next
    review date ride the snapshot so the "in effect since" subtitle is data-driven.

    Args:
        reference: The reference date (server "today") every dated part resolves against.
        current: The live trailing-12-month standing.
        previous: The prior-window standing, or ``None`` when no data exists.
        invoices: The included-invoice drilldown, oldest-first.

    Returns:
        The assembled :class:`MonotributoSnapshot` with the ``as_of=reference`` A-K scale
        and its effective/next-review dates attached.
    """
    return MonotributoSnapshot(
        current=current,
        previous=previous,
        scale=scale_entries(reference),
        invoices=invoices,
        scale_effective_from=scale_for(reference).effective_from,
        scale_next_review=next_scale_review(reference),
    )
