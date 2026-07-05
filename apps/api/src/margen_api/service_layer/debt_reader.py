"""Reader port for the debt query side (ADR-187, ADR-130).

The reader serves the debts list (CRUD GET). It is strictly read-only — debt writes go
through commands on the unit of work (ADR-028) — and is owner-scoped so a caller only
ever sees their own debts (ADR-130). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.debt_read_models import DebtReadModel


class AbstractDebtReader(ABC):
    """Async, read-only query port for debts (ADR-187)."""

    @abstractmethod
    async def list_debts(self, user_id: str) -> list[DebtReadModel]:
        """List the owner's debts, newest-first by creation (ADR-130).

        Args:
            user_id: The authenticated owner; every debt is scoped to it so a caller only
                sees their own (ADR-108, ADR-130).

        Returns:
            The owner's debt read models, newest-first.
        """
