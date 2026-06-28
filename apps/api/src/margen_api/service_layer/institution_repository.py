"""Repository port for the write side of the institution aggregate (ADR-130, ADR-134).

Ports describe the persistence contract application handlers depend on, keeping
the handlers free of SQLAlchemy. Concrete adapters live under
``margen_api.adapters`` (AGENTS.md). The repository serves the write model only;
query paths use the reader port (ADR-028). Every read/write is owner-scoped: a
foreign owner's id is treated as absent so the boundary answers 404 (ADR-111,
ADR-130).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from margen_api.domain.models.institution import Institution


class AbstractInstitutionRepository(ABC):
    """Collection-like async store for :class:`Institution` aggregates (ADR-130)."""

    @abstractmethod
    def add(self, institution: Institution) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Ownership rides on the aggregate (``institution.user_id``), copied onto the
        row so every insert is attributed to the authenticated owner (ADR-130).

        Args:
            institution: The aggregate to persist.
        """

    @abstractmethod
    async def get(self, institution_id: UUID, user_id: str) -> Institution | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-130, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the
        update handler then surfaces a not-found (404 at the boundary, ADR-111).

        Args:
            institution_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The aggregate, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist(self, institution: Institution) -> None:
        """Apply the state of a mutated aggregate to its stored row (update semantics).

        Args:
            institution: The mutated aggregate to persist.
        """

    @abstractmethod
    async def owns(self, institution_id: UUID, user_id: str) -> bool:
        """Return whether ``institution_id`` is an institution owned by ``user_id``.

        Backs the account ownership check (ADR-130, ADR-134): an account may only
        reference an institution the caller owns. A missing institution, or one
        owned by another user, both return ``False`` so the boundary answers 404.

        Args:
            institution_id: The institution identity being linked.
            user_id: The authenticated owner the institution must belong to.

        Returns:
            ``True`` when the owner has an institution with that id, else ``False``.
        """
