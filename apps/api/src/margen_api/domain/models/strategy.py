"""Pure household-floor + strategy-suggestion math (ADR-143, budget-design §9.1).

The feed-free subset of budget-design.md's rules engine: a household floor (the
survival expenses a plan must never underfund), a ratio-to-floor income-pressure
segment, a strategy *suggestion* (the user still picks), and a floor-before-
percentages guard that warns — never silently rebalances — when a saving profile
would push essentials below the floor.

All pure and free of I/O (AGENTS.md). Money is :class:`~decimal.Decimal` (ADR-025).
Volatility, FX and wage-gap scoring (which need 6-month history and a
``MacroSnapshot``) are deferred to Phase 2/3 (ADR-143).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal

from margen_api.domain.models.saving_profiles import SavingProfile

# Income-pressure / strategy ratio-to-floor boundaries (ADR-143, budget-design
# §9.1.2/§9.1.3). Adequacy = income / floor; nominal income bands age badly under
# inflation, so the segments are ratios.
CONSTRAINED_BELOW = Decimal("1.3")
COMFORTABLE_ABOVE = Decimal("2.5")

# Income-pressure segment labels (budget-design §9.1.3).
CONSTRAINED = "constrained"
STABLE = "stable"
COMFORTABLE = "comfortable"

# A debt-service ratio above this keeps the suggestion conservative even when income
# comfortably clears the floor: expensive debt outranks aggressive saving (ADR-143,
# product-deliverable §2.2 sequencing). ``debt_min`` is a manual UI field, not
# persisted (YAGNI, budget-design §9.1.2).
HIGH_DEBT_RATIO = Decimal("0.2")


def compute_floor(
    spend_lines: Mapping[str, Decimal],
    is_essential: Callable[[str], bool],
) -> Decimal:
    """Sum the essential spend targets into the household floor (ADR-143).

    The computed household floor is ``Σ(kind='spend' targets WHERE is_essential)``
    (budget-design §9.1.1): the survival expenses the plan must cover before any
    discretionary spend or saving. Categories the predicate rejects are ignored.

    Args:
        spend_lines: The owner's per-category spend targets for the month, keyed by
            category (``kind='spend'`` rows only).
        is_essential: Predicate classifying a category as essential
            (:func:`margen_api.domain.models.value_objects.is_essential`), injected
            so this stays pure and independently testable.

    Returns:
        The summed essential spend, the computed household floor (``0`` when no
        essential category has a target).
    """
    return sum((amount for category, amount in spend_lines.items() if is_essential(category)), Decimal(0))


def income_pressure(income: Decimal, floor: Decimal) -> str:
    """Classify how much room the income leaves above the household floor (ADR-143).

    The ratio-to-floor segment (budget-design §9.1.3): ``Constrained`` when income
    is under ``1.3x`` the floor, ``Stable`` from ``1.3x`` up to and including
    ``2.5x``, ``Comfortable`` above ``2.5x``. A zero or non-positive floor is treated
    as ``Comfortable`` (no floor pressure when nothing essential is budgeted).

    Args:
        income: The month's net spendable income (ADR-139).
        floor: The household floor (essential spend), computed or manual.

    Returns:
        One of ``"constrained"``, ``"stable"`` or ``"comfortable"``.
    """
    if floor <= 0:
        return COMFORTABLE
    adequacy = income / floor
    if adequacy < CONSTRAINED_BELOW:
        return CONSTRAINED
    if adequacy <= COMFORTABLE_ABOVE:
        return STABLE
    return COMFORTABLE


def suggest_strategy(income: Decimal, floor: Decimal, debt_min: Decimal) -> SavingProfile:
    """Suggest a saving profile from adequacy and the debt-service ratio (ADR-143).

    The feed-free strategy suggestion (budget-design §9.1.2), a reduced subset of
    the full ``choose_strategy`` (volatility / FX / wage-gap dropped to Phase 2/3):

    * ``Constrained`` income (adequacy ``< 1.3x``) → ``Conservative``.
    * Otherwise a high debt-service ratio (``debt_min / income > 0.2``) → keep
      ``Conservative``: kill expensive debt before saving aggressively.
    * ``Comfortable`` income (adequacy ``> 2.5x``) with manageable debt →
      ``Aggressive``.
    * Everything else → ``Balanced`` (the default).

    The result is a *suggestion*; the user still picks (no ``Recommendation`` entity
    in the MVP, ADR-143).

    Args:
        income: The month's net spendable income (ADR-139).
        floor: The household floor (essential spend).
        debt_min: The user's monthly minimum debt payments (a manual UI field, not
            persisted, budget-design §9.1.2).

    Returns:
        The suggested :class:`SavingProfile`.
    """
    pressure = income_pressure(income, floor)
    if pressure == CONSTRAINED:
        return SavingProfile.CONSERVATIVE
    if income > 0 and debt_min / income > HIGH_DEBT_RATIO:
        return SavingProfile.CONSERVATIVE
    if pressure == COMFORTABLE:
        return SavingProfile.AGGRESSIVE
    return SavingProfile.BALANCED


@dataclass(frozen=True, slots=True)
class FloorGuard:
    """The outcome of the floor-before-percentages guard (ADR-138, budget-design §9.1.4).

    Attributes:
        breached: Whether the chosen saving total would push essentials below the
            household floor (``income - saving_total < floor``).
        gap: How far essentials fall short of the floor after saving — a positive
            magnitude when ``breached`` (``floor - (income - saving_total)``), else
            ``0``. Lets the UI quantify "you would underfund essentials by X".
    """

    breached: bool
    gap: Decimal


def floor_guard(income: Decimal, floor: Decimal, saving_total: Decimal) -> FloorGuard:
    """Check whether a saving total underfunds the household floor (ADR-138).

    The floor-before-percentages correctness check (budget-design §9.1.4): after
    setting aside ``saving_total`` from ``income``, the residual must still cover the
    essentials ``floor``. When it does not, the guard reports a breach and the gap so
    the UI can WARN ("consider Conservative") — it does **never** silently rebalance
    (the active ``fund_gap_from_nonessential_buckets`` is deferred). The saving rows
    are still written; only the advisory flag changes.

    Args:
        income: The month's net spendable income (ADR-139).
        floor: The household floor (essential spend), computed or manual.
        saving_total: The total the chosen profile would allocate to savings.

    Returns:
        A :class:`FloorGuard` carrying the breach flag and the (non-negative) gap.
    """
    residual = income - saving_total
    shortfall = floor - residual
    if shortfall > 0:
        return FloorGuard(breached=True, gap=shortfall)
    return FloorGuard(breached=False, gap=Decimal(0))
