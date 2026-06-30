"""Saving-profile presets and the pure allocation math (ADR-138).

Pay-yourself-first templates transcribed verbatim from the research saving tables
(product-deliverable §2.2): three closed profiles whose per-bucket percentages of
net spendable income sum to 20% (Conservative), 30% (Balanced) and 40%
(Aggressive). The presets are **code constants, not DB rows** (they are templates,
not per-user data) and live in pure domain so they are trivially unit-testable and
free of I/O (AGENTS.md).

The buckets reuse the closed
:data:`~margen_api.domain.models.value_objects.SAVING_BUCKETS` set. The profile
percentages are the SIX investing/goal buckets (20/30/40 total); the spend-side
``MaintenanceReserve`` (5/2/2%, an inflation/maintenance sinking pool, also stored
as a ``kind='saving'`` row) is kept separate so the headline "to savings" total
stays the research's 20/30/40. ``compute_saving_rows`` applies a profile to a net-
income base, returning ``{bucket: amount}`` for the apply-profile handler to
persist as ``kind='saving'`` budget rows.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

from margen_api.domain.models.exceptions import UnknownSavingProfileError

CENTS = Decimal("0.01")


class SavingProfile(StrEnum):
    """A closed saving-profile preset (ADR-138).

    ``CONSERVATIVE`` (20% to savings) suits heavy essentials / unstable income;
    ``BALANCED`` (30%, the default) suits stable salaried or predictable freelance;
    ``AGGRESSIVE`` (40%) suits strong income with controlled fixed costs and no
    revolving debt (product-deliverable §2.2 best-fit notes).
    """

    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    AGGRESSIVE = "aggressive"

    @classmethod
    def parse(cls, value: object) -> SavingProfile:
        """Coerce a value to a ``SavingProfile`` or raise ``UnknownSavingProfileError``.

        Args:
            value: A ``SavingProfile`` member or a string such as ``"balanced"``.

        Returns:
            The matching ``SavingProfile`` member.

        Raises:
            UnknownSavingProfileError: When ``value`` is not a known profile.
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise UnknownSavingProfileError(value) from exc


# Per-bucket percentages of net spendable income for each profile (ADR-138).
# Transcribed verbatim from product-deliverable §2.2. The six profile buckets sum
# to the headline 20 / 30 / 40 to-savings total; ``MaintenanceReserve`` (the
# spend-side reserve) is carried separately in ``MAINTENANCE_RESERVE_PCT``.
PROFILE_BUCKETS: dict[SavingProfile, dict[str, int]] = {
    SavingProfile.CONSERVATIVE: {
        "EmergencyFund": 5,
        "DebtAcceleration": 5,
        "ShortTermGoals": 3,
        "MediumTermGoals": 2,
        "LongTermInvestment": 3,
        "FxHedge": 2,
    },
    SavingProfile.BALANCED: {
        "EmergencyFund": 7,
        "DebtAcceleration": 7,
        "ShortTermGoals": 4,
        "MediumTermGoals": 4,
        "LongTermInvestment": 5,
        "FxHedge": 3,
    },
    SavingProfile.AGGRESSIVE: {
        "EmergencyFund": 8,
        "DebtAcceleration": 10,
        "ShortTermGoals": 5,
        "MediumTermGoals": 5,
        "LongTermInvestment": 7,
        "FxHedge": 5,
    },
}

# Spend-side inflation/maintenance reserve as a percentage of net income (ADR-138).
# Stored as a ``kind='saving'`` ``MaintenanceReserve`` row (product-deliverable
# §2.2) but excluded from the 20/30/40 headline to-savings total.
MAINTENANCE_RESERVE_PCT: dict[SavingProfile, int] = {
    SavingProfile.CONSERVATIVE: 5,
    SavingProfile.BALANCED: 2,
    SavingProfile.AGGRESSIVE: 2,
}


def profile_total_pct(profile: SavingProfile) -> int:
    """Return a profile's headline to-savings percentage (20 / 30 / 40, ADR-138).

    The sum of the six profile buckets, excluding the spend-side maintenance
    reserve. Lets callers (and tests) assert the research totals directly.

    Args:
        profile: The saving profile to total.

    Returns:
        The integer percentage of net income the profile allocates to savings.
    """
    return sum(PROFILE_BUCKETS[profile].values())


def _pct_of(base: Decimal, pct: int) -> Decimal:
    """Return ``pct`` percent of ``base`` rounded to cents (ADR-025)."""
    return (base * Decimal(pct) / Decimal(100)).quantize(CENTS, rounding=ROUND_HALF_UP)


def compute_saving_rows(base: Decimal, profile: SavingProfile) -> dict[str, Decimal]:
    """Compute each saving bucket's monthly amount for a net-income base (ADR-138).

    Pure: applies the profile's per-bucket percentages (and the spend-side
    maintenance reserve) to ``base``, the month's net spendable income, returning
    ``{bucket: amount}`` rounded to cents. The apply-profile handler persists each
    entry as a ``kind='saving'`` budget row. Because saving is a percentage of net
    income, the rows auto-reprice when the base changes (no per-bucket reprice math,
    product-deliverable §2.6).

    Args:
        base: The month's net spendable income the percentages apply to (ADR-139).
        profile: The chosen preset (Conservative / Balanced / Aggressive).

    Returns:
        A mapping of every saving-bucket key to its monthly amount, including the
        spend-side ``MaintenanceReserve``. Buckets are emitted even when ``base`` is
        zero (every amount is then ``0``), so re-applying always overwrites the full
        set rather than leaving stale rows.
    """
    rows = {bucket: _pct_of(base, pct) for bucket, pct in PROFILE_BUCKETS[profile].items()}
    rows["MaintenanceReserve"] = _pct_of(base, MAINTENANCE_RESERVE_PCT[profile])
    return rows
