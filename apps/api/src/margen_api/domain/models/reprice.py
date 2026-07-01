"""Pure inflation-reprice math for spend caps (ADR-137).

The behavioral core of the inflation-aware budget: right after each CPI release the
user reprices their spend caps so a January target does not silently describe a
price level gone by March (product-deliverable §2.6). One manual monthly inflation
percentage drives the whole budget; known discrete jumps (rent contract index/ICL,
tariff increases) are added per category as ``step_up``.

Pure and free of I/O so it is trivially unit-testable (AGENTS.md). Money is
:class:`~decimal.Decimal` (ADR-025); the reprice is applied only to ``kind='spend'``
rows — saving rows re-derive from the net-income base, so they are never repriced
here (ADR-137/138).
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")


def reprice_cap(cap: Decimal, monthly_infl: Decimal, step_up: Decimal = Decimal(0)) -> Decimal:
    """Reprice one spend cap for a month of inflation plus a known step-up (ADR-137).

    Computes ``round(cap x (1 + monthly_infl / 100)) + step_up`` to cents: the cap
    grows by the manual monthly inflation percentage, then a known discrete jump
    (rent index, tariff increase) is added on top. A zero ``monthly_infl`` with no
    ``step_up`` returns the cap unchanged (still quantized to cents).

    Args:
        cap: The current month's spend target for the category (ADR-025).
        monthly_infl: The manual monthly inflation assumption as a percentage (e.g.
            ``Decimal("2.1")`` for 2.1%/month), seeded by a REM suggestion the user
            edits (ADR-141). Negative values deflate the cap.
        step_up: A known discrete per-category increase added after the inflation
            adjustment (rent contract index/ICL, tariff increase); defaults to ``0``.

    Returns:
        The repriced cap, rounded to cents (ADR-025).
    """
    inflated = (cap * (Decimal(1) + monthly_infl / Decimal(100))).quantize(CENTS, rounding=ROUND_HALF_UP)
    return inflated + step_up
