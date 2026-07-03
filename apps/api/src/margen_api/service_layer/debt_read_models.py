"""Read models for the debt query side (ADR-187, ADR-130).

Purpose-built, immutable DTOs for the debts list — deliberately separate from the write
aggregate so the two evolve independently (AGENTS.md reader ports + read models). Money
is :class:`~decimal.Decimal` (ADR-025); the API boundary serializes it as the same
Decimal style the rest of the app uses (ADR-030).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from margen_api.domain.models.value_objects import Currency


@dataclass(frozen=True, slots=True)
class DebtReadModel:
    """Query-optimized projection of a persisted debt (ADR-187).

    Attributes:
        id: Stable UUID identity.
        name: Required human display label.
        currency: The debt's native currency, ARS or USD (ADR-183).
        current_balance: The outstanding native-currency amount owed (ADR-187).
        monthly_minimum: Optional minimum monthly payment, or ``None`` (ADR-187).
        rate: Optional interest rate, or ``None`` (ADR-187).
    """

    id: UUID
    name: str
    currency: Currency
    current_balance: Decimal
    monthly_minimum: Decimal | None
    rate: Decimal | None
