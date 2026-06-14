"""AFIP/ARCA Monotributo category scale (A-K) as versioned reference data.

The scale is reference data that ARCA revises roughly once a year. Per ADR-048
and ADR-051 it ships as an immutable, versioned backend constant rather than a
database table: it changes seldom and a constant avoids seed/migration churn.
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
SCALE_VERSION: str = "2026.0"


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


# TODO(ADR-051): verify against official ARCA 2026 table. The values below are
# realistic, monotonically-increasing placeholders derived from the 2025 scale;
# staleness is an accepted, documented risk until an official 2026 source is
# confirmed. Update SCALE_YEAR/SCALE_VERSION when these are refreshed.
MONOTRIBUTO_SCALE: tuple[MonotributoCategory, ...] = (
    MonotributoCategory("A", Decimal("8992597.87"), Decimal("37085.74"), Decimal("37085.74")),
    MonotributoCategory("B", Decimal("13175201.52"), Decimal("42216.41"), Decimal("42216.41")),
    MonotributoCategory("C", Decimal("18473166.15"), Decimal("49435.58"), Decimal("48592.10")),
    MonotributoCategory("D", Decimal("22934610.05"), Decimal("70975.34"), Decimal("69148.45")),
    MonotributoCategory("E", Decimal("26977793.60"), Decimal("114598.97"), Decimal("106370.04")),
    MonotributoCategory("F", Decimal("33809379.57"), Decimal("141742.85"), Decimal("129489.91")),
    MonotributoCategory("G", Decimal("40431835.35"), Decimal("198817.79"), Decimal("160961.10")),
    MonotributoCategory("H", Decimal("61344853.64"), Decimal("431513.78"), Decimal("330579.16")),
    MonotributoCategory("I", Decimal("68664410.05"), Decimal("612656.96"), Decimal("488559.13")),
    MonotributoCategory("J", Decimal("78632948.76"), Decimal("731103.20"), Decimal("562861.99")),
    MonotributoCategory("K", Decimal("94805682.90"), Decimal("868662.46"), Decimal("642668.16")),
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
