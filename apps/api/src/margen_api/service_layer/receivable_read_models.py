"""Read models for the receivables query side (ADR-204, ADR-206, ADR-130).

Purpose-built, immutable DTOs for the receivables surface — deliberately separate from the
write aggregates so the two evolve independently (AGENTS.md reader ports + read models).
Money is :class:`~decimal.Decimal` (ADR-025), ARS-only for v1; the API boundary serializes
it as the same Decimal style the rest of the app uses (ADR-030).

The roll-ups these carry are the ADR-206 settlement figures computed query-side over the
persisted rows: an item's ``remaining`` = ``amount`` - Σ its allocations, and a person's
``outstanding`` = Σ of their items' remainders. Nothing here carries an ``account_id`` —
receivables never enter net-worth aggregation (ADR-205).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True, slots=True)
class ReceivableItemReadModel:
    """Query-optimized projection of one itemized debt with its settlement roll-up (ADR-206).

    Attributes:
        id: Stable UUID identity.
        occurred_on: The calendar date the debt was incurred.
        amount: The positive ARS magnitude originally owed for this item (ADR-025).
        detail: The optional free-text justification, or ``None``.
        allocated: The sum of the payment allocations applied to this item so far.
        remaining: ``amount`` - ``allocated`` — the item's outstanding remainder; may be
            negative once a confirmed overpayment credits the item beyond its amount
            (ADR-206). For a pardoned item this is the amount "covered by you" (ADR-210).
        pardoned: Whether the owner has forgiven this item (ADR-210). A pardoned item is
            excluded from the person's ``outstanding`` and is no longer a valid allocation
            target, but is retained so it can be shown as "covered by you".
    """

    id: UUID
    occurred_on: date
    amount: Decimal
    detail: str | None
    allocated: Decimal
    remaining: Decimal
    pardoned: bool = False


@dataclass(frozen=True, slots=True)
class PersonReadModel:
    """Query-optimized projection of a person and their outstanding total (ADR-204, ADR-206).

    Backs the people list: one row per debtor with the single roll-up the list needs.

    Attributes:
        id: Stable UUID identity.
        name: The debtor's display label.
        created_at: Server-managed creation timestamp (drives newest-first ordering).
        outstanding: Σ of the person's item remainders — the money they still owe overall
            (ADR-206); may be negative after a confirmed overpayment credit.
    """

    id: UUID
    name: str
    created_at: datetime
    outstanding: Decimal


@dataclass(frozen=True, slots=True)
class PersonDetailReadModel:
    """Query-optimized projection of one person with their per-item remainders (ADR-206).

    Backs the person detail surface: the debtor plus every itemized debt and its remainder,
    with the person-level outstanding total pre-summed for convenience.

    Attributes:
        id: Stable UUID identity.
        name: The debtor's display label.
        created_at: Server-managed creation timestamp.
        outstanding: Σ of the NON-pardoned ``items`` remainders — the person's overall
            outstanding (ADR-206); pardoned items are excluded (ADR-210).
        items: The person's itemized debts with their per-item settlement roll-ups and
            pardon flag, newest-first by ``occurred_on`` (pardoned items included so the
            "covered by you" surface can render them, ADR-210).
    """

    id: UUID
    name: str
    created_at: datetime
    outstanding: Decimal
    items: tuple[ReceivableItemReadModel, ...]
