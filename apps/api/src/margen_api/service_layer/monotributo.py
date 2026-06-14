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
from decimal import Decimal

from margen_api.domain.models.monotributo_scale import (
    current_scale,
    get_ceiling,
    smallest_category_for,
)
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
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


def scale_entries() -> list[MonotributoScaleEntry]:
    """Return the current A-K reference scale as read-model entries (ADR-048, ADR-067).

    The page shows the current scale, so this returns the latest vintage's rows.
    """
    return [
        MonotributoScaleEntry(
            letter=row.letter,
            annual_ceiling=row.annual_ceiling,
            cuota_servicios=row.cuota_servicios,
            cuota_bienes=row.cuota_bienes,
        )
        for row in current_scale().categories
    ]


def build_snapshot(
    *,
    current: MonotributoStanding,
    previous: MonotributoStanding | None,
    invoices: list[MonotributoInvoice],
) -> MonotributoSnapshot:
    """Assemble the full Monotributo page snapshot (ADR-052).

    Args:
        current: The live trailing-12-month standing.
        previous: The prior-window standing, or ``None`` when no data exists.
        invoices: The included-invoice drilldown, oldest-first.

    Returns:
        The assembled :class:`MonotributoSnapshot` with the A-K scale attached.
    """
    return MonotributoSnapshot(
        current=current,
        previous=previous,
        scale=scale_entries(),
        invoices=invoices,
    )
