"""Repository port for the write side of the account aggregate (ADR-122, ADR-130).

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

from margen_api.domain.models.account import Account


class AbstractAccountRepository(ABC):
    """Collection-like async store for :class:`Account` aggregates (ADR-130)."""

    @abstractmethod
    def add(self, account: Account) -> None:
        """Stage a new aggregate for persistence on the next commit.

        Ownership rides on the aggregate (``account.user_id``), copied onto the
        row so every insert is attributed to the authenticated owner (ADR-130).

        Args:
            account: The aggregate to persist.
        """

    @abstractmethod
    async def get(self, account_id: UUID, user_id: str) -> Account | None:
        """Load one of the owner's aggregates by identity, or ``None`` (ADR-130, ADR-111).

        Scoped to ``user_id`` so a foreign owner's id is treated as absent — the
        update handler then surfaces a not-found (404 at the boundary, ADR-111).

        Args:
            account_id: The aggregate identity.
            user_id: The authenticated owner the row must belong to.

        Returns:
            The aggregate, or ``None`` when no row matches the id for this owner.
        """

    @abstractmethod
    async def persist(self, account: Account) -> None:
        """Apply the state of a mutated aggregate to its stored row (update semantics).

        Args:
            account: The mutated aggregate to persist.
        """

    @abstractmethod
    async def owns(self, account_id: UUID, user_id: str) -> bool:
        """Return whether ``account_id`` is an existing account owned by ``user_id``.

        Backs the transaction ownership check (ADR-130): a transaction may only be
        linked to an account the caller owns. A missing account, or one owned by
        another user, both return ``False`` so the boundary answers 404/422.

        Args:
            account_id: The account identity being linked.
            user_id: The authenticated owner the account must belong to.

        Returns:
            ``True`` when the owner has an account with that id, else ``False``.
        """
