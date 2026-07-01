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
        usd_amount: Materialized USD equivalent for USD rows, else ``None`` (ADR-148).
        fx_rate: Rate used for the USD to ARS conversion (ARS per 1 USD), else ``None``.
        fx_source: Provenance of the FX snapshot rate (ADR-148), else ``None``.
        fx_rate_type: Rate family, else ``None``.
        fx_rate_as_of: Timestamp the rate was observed, else ``None``.
        category: Validated category string, optional.
        payment_method: Normalized bank / channel label, optional (ADR-117).
        card: Optional card / detail label for display (e.g. ``"VISA ·5771"``);
            ``None`` when there is no card (ADR-117).
        notes: Free-form optional note, distinct from ``name`` (ADR-024).
        recurring: Whether the movement repeats.
        counts_toward_monotributo: Monotributo counting hint.
        statement_document_id: Link to the source statement document for an imported
            credit-card expense, else ``None`` for a manually-entered transaction.
            Lets query paths distinguish manual expenses (the reconciliation candidate
            pool — ADR-084) from already-imported statement rows.
        account_id: Link to the owning account, else ``None`` when the transaction
            is not attributed to an account (ADR-122).
        offsets_transaction_id: For a ``reimbursement`` (ADR-158), the linked expense
            id this payback offsets (ADR-159); ``None`` for every other kind. Lets the
            client render the "reimbursed" relationship without a second lookup.
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
    fx_source: str | None
    fx_rate_type: FxRateType | None
    fx_rate_as_of: datetime | None
    category: str | None
    payment_method: str | None
    card: str | None
    notes: str | None
    recurring: bool
    counts_toward_monotributo: bool
    statement_document_id: UUID | None
    account_id: UUID | None
    offsets_transaction_id: UUID | None
    created_at: datetime
    updated_at: datetime
