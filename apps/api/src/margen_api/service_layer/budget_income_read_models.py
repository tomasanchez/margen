"""Read models for the budget-income query side (ADR-139, ADR-143).

Purpose-built, immutable DTOs for the net-income-base surface — separate from the
write aggregate so the two evolve independently (AGENTS.md). The income readout pairs
the month's net spendable income (``amount`` + ``currency`` + ``source``) with the
household floor (``floor_amount`` + ``floor_source``); both floor fields are ``None``
when the user has not set or computed a floor. Money is :class:`~decimal.Decimal`
(ADR-025).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from margen_api.domain.models.value_objects import Currency


@dataclass(frozen=True, slots=True)
class BudgetIncomeReadModel:
    """The net-income-base + household-floor readout for a month (ADR-139, ADR-143).

    Attributes:
        month: The requested month as ``YYYY-MM`` (the month-navigator period,
            ADR-040).
        amount: The month's net spendable income, or ``None`` when no base is set.
        currency: The base currency; ARS for the MVP (ADR-125).
        source: Provenance of ``amount`` — ``manual`` (MVP) or ``monotributo``
            (Phase 3); ``None`` when no base is set.
        floor_amount: The household floor (essentials spend), or ``None`` when unset.
        floor_source: Provenance of ``floor_amount`` — ``manual`` or ``computed``;
            ``None`` when no floor is set.
    """

    month: str
    amount: Decimal | None
    currency: Currency
    source: str | None
    floor_amount: Decimal | None
    floor_source: str | None
