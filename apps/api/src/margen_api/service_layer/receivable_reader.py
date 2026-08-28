"""Reader port for the receivables query side (ADR-204, ADR-206, ADR-130).

The reader serves the people list and the per-person detail with settlement roll-ups. It
is strictly read-only — receivables writes go through commands on the unit of work
(ADR-028) — and is owner-scoped so a caller only ever sees their own people (ADR-130). The
concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.service_layer.receivable_read_models import (
    PersonDetailReadModel,
    PersonReadModel,
)


class AbstractReceivableReader(ABC):
    """Async, read-only query port for people and their outstanding balances (ADR-204)."""

    @abstractmethod
    async def list_people(self, user_id: str) -> list[PersonReadModel]:
        """List the owner's people with outstanding totals, newest-first by creation (ADR-130).

        Args:
            user_id: The authenticated owner; every person is scoped to it so a caller
                only sees their own (ADR-108, ADR-130).

        Returns:
            The owner's people with their Σ-item-remainder outstanding, newest-first.
        """

    @abstractmethod
    async def get_person(self, person_id: UUID, user_id: str) -> PersonDetailReadModel | None:
        """Load one person with per-item remainders, or ``None`` (ADR-206, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the boundary
        then answers 404 (ADR-111).

        Args:
            person_id: The person identity.
            user_id: The authenticated owner the person must belong to.

        Returns:
            The person detail with its items and roll-ups, or ``None`` when absent for
            this owner.
        """
