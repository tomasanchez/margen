"""Reader port for the account + net-worth query side (ADR-122, ADR-123).

The reader serves the accounts list (CRUD GET) and the net-worth surface. It is
strictly read-only — account writes go through commands on the unit of work
(ADR-028) — and is owner-scoped so a caller only ever sees their own accounts
(ADR-130). The concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.account_read_models import AccountReadModel, NetWorth


class AbstractAccountReader(ABC):
    """Async, read-only query port for accounts and net worth (ADR-122)."""

    @abstractmethod
    async def list_accounts(self, user_id: str) -> list[AccountReadModel]:
        """List the owner's accounts, newest-first by creation (ADR-130).

        Args:
            user_id: The authenticated owner; every account is scoped to it so a
                caller only sees their own (ADR-108, ADR-130).

        Returns:
            The owner's account read models, newest-first.
        """

    @abstractmethod
    async def net_worth(self, user_id: str) -> NetWorth:
        """Compute the owner's net worth and per-account breakdown (ADR-122, ADR-123).

        Each account's balance is ``opening_balance + Σ signed transaction deltas``
        in the account's native currency; the total sums those balances converted
        into the owner's display currency via the MEP rate (ADR-123). When no MEP
        rate is available the converted figures degrade to native (ADR-132).

        Args:
            user_id: The authenticated owner; the accounts, their transactions, the
                display-currency preference and the MEP rate are all scoped to it
                (ADR-108, ADR-130).

        Returns:
            The assembled :class:`NetWorth`.
        """
