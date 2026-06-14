"""AFIP/ARCA Monotributo category scale (A-K) as versioned reference data.

The scale is reference data that ARCA revises each semester (≈ February and
August, indexed to inflation). Per ADR-048 and ADR-051 it ships as an immutable,
versioned backend constant rather than a database table: it changes seldom and a
constant avoids seed/migration churn.
Money values are :class:`~decimal.Decimal` (ADR-025) -- never floats.

Categories A-H apply to both services (*servicios*) and goods (*bienes*);
categories I-K are goods-only in the real scale, but every letter is modelled
with both monthly cuotas here so callers have a uniform structure. Services is
the MVP path (ADR-046).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

# Marker for the scale vintage. Bump this and the data together when ARCA
# publishes a new table.
SCALE_YEAR: int = 2026
# Values in effect February-July 2026 (ARCA's first-semester table, the +14.28%
# IPC adjustment over the 2025 close). The next revision lands for the second
# semester (~August 2026) — bump SCALE_VERSION + the data together then.
SCALE_VERSION: str = "2026-02"


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


# Official ARCA scale in effect February-July 2026 (ADR-051). Annual ceilings +
# total monthly cuotas (impuesto integrado + SIPA + obra social). Categories A-B
# carry a single cuota (servicios == bienes); C-K differentiate the two.
# Source: ARCA first-semester 2026 table (matches the frontend's AFIP-2026 scale).
MONOTRIBUTO_SCALE: tuple[MonotributoCategory, ...] = (
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
)

# Index by letter for O(1) lookups.
_SCALE_BY_LETTER: dict[str, MonotributoCategory] = {row.letter: row for row in MONOTRIBUTO_SCALE}

# The valid category letters, derived from the scale so there is no duplicated
# A-K list to keep in sync (ADR-046).
KNOWN_CATEGORIES: frozenset[str] = frozenset(_SCALE_BY_LETTER)


class UnknownCategoryError(Exception):
    """Raised when a category letter is not a known A-K Monotributo band (ADR-046).

    The config write path raises this so the boundary can translate it into a
    ``422 Unprocessable Entity`` (ADR-030). The carried ``category`` lets the
    entrypoint build a meaningful message.
    """

    def __init__(self, category: object) -> None:
        self.category = category
        super().__init__(f"unknown Monotributo category: {category!r} (expected one of A-K)")


def get_category(letter: str) -> MonotributoCategory:
    """Return the full category row for ``letter``.

    Args:
        letter: A category letter ``"A"``-``"K"`` (case-insensitive).

    Returns:
        The matching :class:`MonotributoCategory`.

    Raises:
        KeyError: When ``letter`` is not a known category.
    """
    return _SCALE_BY_LETTER[letter.upper()]


def get_ceiling(letter: str) -> Decimal:
    """Return the annual ceiling for a category ``letter``.

    Args:
        letter: A category letter ``"A"``-``"K"`` (case-insensitive).

    Returns:
        The category's annual ceiling in ARS.

    Raises:
        KeyError: When ``letter`` is not a known category.
    """
    return get_category(letter).annual_ceiling


def smallest_category_for(amount: Decimal) -> str:
    """Return the smallest category whose ceiling covers ``amount``.

    Args:
        amount: A trailing-12-month gross income in ARS.

    Returns:
        The letter of the smallest category whose ``annual_ceiling`` is greater
        than or equal to ``amount``. When ``amount`` exceeds every ceiling the
        top category (``"K"``) is returned -- the caller decides whether that
        means "exclusion" since the scale has no higher band.
    """
    for row in MONOTRIBUTO_SCALE:
        if amount <= row.annual_ceiling:
            return row.letter
    return MONOTRIBUTO_SCALE[-1].letter
