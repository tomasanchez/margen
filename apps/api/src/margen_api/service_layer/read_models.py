"""Read models for the transaction query side (ADR-028).

A read model is a purpose-built, immutable DTO for query paths — deliberately
separate from the write aggregate so the two can evolve independently (AGENTS.md
reader ports + read models). It carries the persisted ``kind`` plus the derived
``type`` so callers (and the API layer) need not reconstruct the aggregate to
display direction (ADR-027).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType


@dataclass(frozen=True, slots=True)
class TransactionReadModel:
    """Query-optimized projection of a persisted transaction.

    Attributes:
        id: Stable UUID identity.
        occurred_on: Calendar date the movement happened.
        name: Required human display label (ADR-024).
        kind: Persisted money kind (expense / income / invoice).
        type: High-level direction derived from ``kind`` (ADR-027).
        amount: Positive ARS-equivalent magnitude.
        currency: ARS (base) or USD.
        usd_amount: Original USD amount for USD rows, else ``None``.
        fx_rate: Rate used for the USD to ARS conversion, else ``None``.
        fx_rate_type: Rate family, else ``None``.
        fx_rate_as_of: Timestamp the rate was observed, else ``None``.
        category: Validated category string, optional.
        payment_method: Bank / card / channel label, optional.
        notes: Free-form optional note, distinct from ``name`` (ADR-024).
        recurring: Whether the movement repeats.
        counts_toward_monotributo: Monotributo counting hint.
        created_at: Server-managed creation timestamp.
        updated_at: Server-managed last-update timestamp.
    """

    id: UUID
    occurred_on: date
    name: str
    kind: Kind
    type: TxType
    amount: Decimal
    currency: Currency
    usd_amount: Decimal | None
    fx_rate: Decimal | None
    fx_rate_type: FxRateType | None
    fx_rate_as_of: datetime | None
    category: str | None
    payment_method: str | None
    notes: str | None
    recurring: bool
    counts_toward_monotributo: bool
    created_at: datetime
    updated_at: datetime
