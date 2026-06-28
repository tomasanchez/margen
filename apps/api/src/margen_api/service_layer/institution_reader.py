"""Reader port for the institution query side (ADR-130, ADR-134).

The reader serves the institutions list (CRUD GET). It is strictly read-only —
institution writes go through commands on the unit of work (ADR-028) — and is
owner-scoped so a caller only ever sees their own institutions (ADR-130). The
concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.institution_read_models import InstitutionReadModel


class AbstractInstitutionReader(ABC):
    """Async, read-only query port for institutions (ADR-134)."""

    @abstractmethod
    async def list_institutions(self, user_id: str) -> list[InstitutionReadModel]:
        """List the owner's institutions, newest-first by creation (ADR-130).

        Args:
            user_id: The authenticated owner; every institution is scoped to it so
                a caller only sees their own (ADR-108, ADR-130).

        Returns:
            The owner's institution read models, newest-first.
        """
