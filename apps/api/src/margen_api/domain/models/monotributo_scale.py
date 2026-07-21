"""AFIP/ARCA Monotributo category scale (A-K) as a versioned, effective-dated registry.

The scale is reference data that ARCA revises each semester (≈ February and
August, indexed to inflation). Per ADR-067 (superseding ADR-048) it ships as an
ordered, effective-dated **registry** of immutable vintages rather than a single
current-only constant or a database table: it changes seldom, an in-code
structure avoids seed/migration churn, and keeping every vintage preserves the
historical scale in code (not just in git history).

Each :class:`MonotributoScaleVersion` carries an ``effective_from`` date and the
full A-K table for that ARCA vintage. The registry
(:data:`MONOTRIBUTO_SCALES`) is ordered by ``effective_from`` ascending. A new
ARCA semester is added by **appending** a new vintage (≈ Feb/Aug); existing
vintages are never overwritten, so history accrues automatically.

Selection by date (:func:`scale_for`):

* ``as_of is None`` -> the **latest** vintage. The domain stays clock-free:
  "current" means "the latest registry entry", and callers (not the domain) own
  the clock. This preserves every existing call site's behavior — the live
  calculation runs on the current scale.
* ``as_of`` given -> the latest vintage whose ``effective_from <= as_of`` (so a
  past period resolves to the vintage in effect at the time — the ADR-052
  backfill correctness fix).
* ``as_of`` predates every vintage -> the **earliest** vintage (documented
  fallback; there is no ceiling on record before the first vintage, so the
  oldest known table is the safest approximation).

The lookup helpers :func:`get_category`, :func:`get_ceiling` and
:func:`smallest_category_for` take an optional ``as_of`` and resolve through
:func:`scale_for`. Money values are :class:`~decimal.Decimal` (ADR-025) -- never
floats.

Categories A-H apply to both services (*servicios*) and goods (*bienes*);
categories I-K are goods-only in the real scale, but every letter is modelled
with both monthly cuotas here so callers have a uniform structure. Services is
the MVP path (ADR-046).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class MonotributoCategory:
    """A single Monotributo category row.

    Attributes:
        letter: The category letter, ``"A"`` through ``"K"``.
        annual_ceiling: Maximum trailing-12-month gross income for the category,
            in ARS.
        cuota_servicios: Monthly all-in cuota for a services taxpayer, in ARS.
        cuota_bienes: Monthly all-in cuota for a goods taxpayer, in ARS.
    """

    letter: str
    annual_ceiling: Decimal
    cuota_servicios: Decimal
    cuota_bienes: Decimal


@dataclass(frozen=True, slots=True)
class MonotributoScaleVersion:
    """One effective-dated ARCA scale vintage (ADR-067).

    Attributes:
        version: The vintage marker, e.g. ``"2026-02"`` (year + ARCA semester).
        effective_from: The first date this vintage applies.
        categories: The full A-K rows for the vintage, ordered by ceiling.
        _by_letter: Internal letter -> row index for O(1) lookups, derived from
            ``categories``.
    """

    version: str
    effective_from: date
    categories: tuple[MonotributoCategory, ...]
    _by_letter: dict[str, MonotributoCategory] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        # frozen dataclass: set the derived index via object.__setattr__.
        object.__setattr__(self, "_by_letter", {row.letter: row for row in self.categories})

    def category(self, letter: str) -> MonotributoCategory:
        """Return the row for ``letter`` (case-insensitive).

        Raises:
            KeyError: When ``letter`` is not a known category in this vintage.
        """
        return self._by_letter[letter.upper()]


# Official ARCA second-semester 2025 table (in effect ~Aug 2025 through Jan 2026).
# Annual ceilings + total monthly cuotas (impuesto integrado + SIPA + obra social).
# Categories A-B carry a single cuota (servicios == bienes); C-K differentiate.
_SCALE_2025_08 = MonotributoScaleVersion(
    version="2025-08",
    effective_from=date(2025, 8, 1),
    categories=(
        MonotributoCategory("A", Decimal("8992597.87"), Decimal("37085.74"), Decimal("37085.74")),
        MonotributoCategory("B", Decimal("13175201.52"), Decimal("42216.41"), Decimal("42216.41")),
        MonotributoCategory("C", Decimal("18473166.15"), Decimal("49435.58"), Decimal("48320.22")),
        MonotributoCategory("D", Decimal("22934610.05"), Decimal("63357.80"), Decimal("61824.18")),
        MonotributoCategory("E", Decimal("26977793.60"), Decimal("89714.31"), Decimal("81070.26")),
        MonotributoCategory("F", Decimal("33809379.57"), Decimal("112906.59"), Decimal("97291.54")),
        MonotributoCategory("G", Decimal("40431835.35"), Decimal("172457.38"), Decimal("118920.05")),
        MonotributoCategory("H", Decimal("61344853.64"), Decimal("391400.62"), Decimal("238038.48")),
        MonotributoCategory("I", Decimal("68664410.05"), Decimal("721650.46"), Decimal("355672.64")),
        MonotributoCategory("J", Decimal("78632948.76"), Decimal("874069.29"), Decimal("434895.92")),
        MonotributoCategory("K", Decimal("94805682.90"), Decimal("1208890.60"), Decimal("525732.01")),
    ),
)

# Official ARCA first-semester 2026 table (in effect Feb-Jul 2026, the +14.28%
# IPC adjustment over the 2025 close). This is the current vintage and matches
# the frontend's AFIP-2026 scale (ADR-051).
_SCALE_2026_02 = MonotributoScaleVersion(
    version="2026-02",
    effective_from=date(2026, 2, 1),
    categories=(
        MonotributoCategory("A", Decimal("10277988.13"), Decimal("42386.74"), Decimal("42386.74")),
        MonotributoCategory("B", Decimal("15058447.71"), Decimal("48250.78"), Decimal("48250.78")),
        MonotributoCategory("C", Decimal("21113696.52"), Decimal("56501.85"), Decimal("55227.06")),
        MonotributoCategory("D", Decimal("26212853.42"), Decimal("72414.10"), Decimal("70661.26")),
        MonotributoCategory("E", Decimal("30833964.37"), Decimal("102537.97"), Decimal("92658.35")),
        MonotributoCategory("F", Decimal("38642048.36"), Decimal("129045.32"), Decimal("111198.27")),
        MonotributoCategory("G", Decimal("46211109.37"), Decimal("197108.23"), Decimal("135918.34")),
        MonotributoCategory("H", Decimal("70113407.33"), Decimal("447346.93"), Decimal("272063.40")),
        MonotributoCategory("I", Decimal("78479211.62"), Decimal("824802.26"), Decimal("406512.05")),
        MonotributoCategory("J", Decimal("89872640.30"), Decimal("999007.65"), Decimal("497059.41")),
        MonotributoCategory("K", Decimal("108357084.05"), Decimal("1381687.90"), Decimal("600879.51")),
    ),
)

# Official ARCA second-semester 2026 table (in effect from Aug 1 2026, the +16.8%
# IPC adjustment over the 2026-02 vintage). Verified against the AFIP page + press:
# the A and K ceilings are confirmed to the cent. This is the latest published
# vintage; because its effective_from is Aug 1 2026, ``scale_for(as_of)`` still
# resolves live standings to the 2026-02 vintage until then (ADR-052/067).
_SCALE_2026_08 = MonotributoScaleVersion(
    version="2026-08",
    effective_from=date(2026, 8, 1),
    categories=(
        MonotributoCategory("A", Decimal("12009410.45"), Decimal("49527.18"), Decimal("49527.18")),
        MonotributoCategory("B", Decimal("17595182.74"), Decimal("56379.08"), Decimal("56379.08")),
        MonotributoCategory("C", Decimal("24670494.31"), Decimal("66020.12"), Decimal("64530.58")),
        MonotributoCategory("D", Decimal("30628651.43"), Decimal("84612.93"), Decimal("82564.81")),
        MonotributoCategory("E", Decimal("36028231.33"), Decimal("119811.45"), Decimal("108267.51")),
        MonotributoCategory("F", Decimal("45151659.41"), Decimal("150784.21"), Decimal("129930.65")),
        MonotributoCategory("G", Decimal("53995798.87"), Decimal("230312.94"), Decimal("158815.05")),
        MonotributoCategory("H", Decimal("81924660.37"), Decimal("522706.68"), Decimal("317895.01")),
        MonotributoCategory("I", Decimal("91699761.90"), Decimal("963747.86"), Decimal("474992.78")),
        MonotributoCategory("J", Decimal("105012519.20"), Decimal("1167299.76"), Decimal("580793.69")),
        MonotributoCategory("K", Decimal("126610838.75"), Decimal("1614446.04"), Decimal("702103.24")),
    ),
)

# The effective-dated registry, ordered by effective_from ascending. APPEND a new
# vintage each ARCA semester (≈ Feb/Aug); never overwrite an existing entry.
MONOTRIBUTO_SCALES: tuple[MonotributoScaleVersion, ...] = (_SCALE_2025_08, _SCALE_2026_02, _SCALE_2026_08)

# Convenience markers for the current (latest) vintage. Other modules that need
# the "current" table import these or call current_scale()/scale_for().
CURRENT_SCALE_VERSION: str = MONOTRIBUTO_SCALES[-1].version
CURRENT_SCALE_YEAR: int = MONOTRIBUTO_SCALES[-1].effective_from.year

# The valid category letters, derived from the latest vintage so there is no
# duplicated A-K list to keep in sync. A-K are identical across vintages (ADR-046).
KNOWN_CATEGORIES: frozenset[str] = frozenset(row.letter for row in MONOTRIBUTO_SCALES[-1].categories)


class UnknownCategoryError(Exception):
    """Raised when a category letter is not a known A-K Monotributo band (ADR-046).

    The config write path raises this so the boundary can translate it into a
    ``422 Unprocessable Entity`` (ADR-030). The carried ``category`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, category: object) -> None:
        self.category = category
        super().__init__(f"unknown Monotributo category: {category!r} (expected one of A-K)")


def current_scale() -> MonotributoScaleVersion:
    """Return the latest (current) scale vintage (ADR-067).

    The endpoints display the current A-K table; this is the convenience source
    for "the scale shown on the page".
    """
    return MONOTRIBUTO_SCALES[-1]


def scale_for(as_of: date | None = None) -> MonotributoScaleVersion:
    """Return the scale vintage in effect on ``as_of`` (ADR-067).

    Args:
        as_of: The date to resolve the vintage for. ``None`` (the default)
            returns the latest vintage, keeping the domain clock-free — callers
            own the clock and "current" means the latest registry entry.

    Returns:
        When ``as_of`` is ``None``: the latest vintage. Otherwise: the latest
        vintage whose ``effective_from`` is on or before ``as_of``. When
        ``as_of`` predates every vintage, the earliest vintage is returned as a
        documented fallback (no ceiling exists on record before the first
        vintage, so the oldest known table is the safest approximation).
    """
    if as_of is None:
        return MONOTRIBUTO_SCALES[-1]
    selected = MONOTRIBUTO_SCALES[0]
    for vintage in MONOTRIBUTO_SCALES:
        if vintage.effective_from <= as_of:
            selected = vintage
        else:
            break
    return selected


# ARCA revises the scale each semester, so the review cadence is six calendar months.
_REVIEW_CADENCE_MONTHS = 6


def next_scale_review(as_of: date | None = None) -> date:
    """Return the date the ``as_of`` vintage is expected to be superseded (ADR-067).

    The "next review" the page surfaces alongside the in-effect scale: when a later
    vintage already exists in the registry, its ``effective_from`` (the exact date the
    scale will change); otherwise the resolved vintage is the latest published one, so
    the estimate is its ``effective_from`` plus the six-month ARCA semester cadence.

    Args:
        as_of: The date selecting the in-effect vintage; ``None`` uses the latest
            (current) vintage (ADR-067).

    Returns:
        The next later vintage's ``effective_from`` when one exists, else the resolved
        vintage's ``effective_from`` advanced by six months (the review cadence).
    """
    resolved = scale_for(as_of)
    for vintage in MONOTRIBUTO_SCALES:
        if vintage.effective_from > resolved.effective_from:
            return vintage.effective_from
    start = resolved.effective_from
    index = start.year * 12 + (start.month - 1) + _REVIEW_CADENCE_MONTHS
    year, month = divmod(index, 12)
    return date(year, month + 1, start.day)


def get_category(letter: str, as_of: date | None = None) -> MonotributoCategory:
    """Return the full category row for ``letter`` in the vintage for ``as_of``.

    Args:
        letter: A category letter ``"A"``-``"K"`` (case-insensitive).
        as_of: The date selecting the scale vintage; ``None`` uses the latest
            (current) vintage (ADR-067).

    Returns:
        The matching :class:`MonotributoCategory`.

    Raises:
        KeyError: When ``letter`` is not a known category.
    """
    return scale_for(as_of).category(letter)


def get_ceiling(letter: str, as_of: date | None = None) -> Decimal:
    """Return the annual ceiling for a category ``letter`` in the ``as_of`` vintage.

    Args:
        letter: A category letter ``"A"``-``"K"`` (case-insensitive).
        as_of: The date selecting the scale vintage; ``None`` uses the latest
            (current) vintage (ADR-067).

    Returns:
        The category's annual ceiling in ARS.

    Raises:
        KeyError: When ``letter`` is not a known category.
    """
    return get_category(letter, as_of).annual_ceiling


def smallest_category_for(amount: Decimal, as_of: date | None = None) -> str:
    """Return the smallest category whose ceiling covers ``amount`` in the ``as_of`` vintage.

    Args:
        amount: A trailing-12-month gross income in ARS.
        as_of: The date selecting the scale vintage; ``None`` uses the latest
            (current) vintage (ADR-067).

    Returns:
        The letter of the smallest category whose ``annual_ceiling`` is greater
        than or equal to ``amount``. When ``amount`` exceeds every ceiling the
        top category (``"K"``) is returned -- the caller decides whether that
        means "exclusion" since the scale has no higher band.
    """
    categories = scale_for(as_of).categories
    for row in categories:
        if amount <= row.annual_ceiling:
            return row.letter
    return categories[-1].letter
