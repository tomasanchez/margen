"""Read models for the transfer query side (ADR-135).

Purpose-built, immutable DTOs for the transfers list — deliberately separate from
the write aggregate so the two evolve independently (AGENTS.md reader ports + read
models). Money is :class:`~decimal.Decimal` (ADR-025); the API boundary serializes
it as the same Decimal style the rest of the app uses (ADR-030).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True, slots=True)
class TransferReadModel:
    """Query-optimized projection of a persisted transfer (ADR-135).

    Attributes:
        id: Stable UUID identity.
        from_account_id: The source account's UUID; money was debited from it.
        to_account_id: The destination account's UUID; money was credited to it.
        amount_out: The source-native magnitude debited (ADR-123, ADR-025).
        amount_in: The destination-native magnitude credited (ADR-123, ADR-025).
        occurred_on: The calendar date the transfer happened.
        note: The optional free-form note, or ``None``.
    """

    id: UUID
    from_account_id: UUID
    to_account_id: UUID
    amount_out: Decimal
    amount_in: Decimal
    occurred_on: date
    note: str | None
