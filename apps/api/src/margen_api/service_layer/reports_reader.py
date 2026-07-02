"""Reader port for the reports query side (ADR-163, ADR-164).

The reader serves the Reports page's net-worth history series and is strictly
read-only — no writes flow through it. It is owner-scoped so a caller only ever
sees their own accounts (ADR-130, ADR-131). The concrete adapter lives under
``margen_api.adapters``. The trend / category / budget report surfaces are served
by the EXISTING readers (summaries, budgets) and are intentionally NOT duplicated
here (ADR-163).
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.net_worth_history import DEFAULT_MONTHS
from margen_api.service_layer.reports_read_models import NetWorthHistory


class AbstractReportsReader(ABC):
    """Async, read-only query port for the reports net-worth history (ADR-164)."""

    @abstractmethod
    async def net_worth_history(self, user_id: str, *, months: int = DEFAULT_MONTHS) -> NetWorthHistory:
        """Return the owner's monthly net-worth history, oldest-first (ADR-164, ADR-131).

        Each month carries the cumulative month-END NATIVE balance per currency
        (opening balances + signed transaction deltas + net transfer flow up to and
        including the month, ADR-122/135). No currency conversion is performed — the
        frontend converts each ``(ars_total, usd_total)`` pair at the live MEP rate
        (ADR-164). The window ends at the current calendar month and is clamped to
        the supported range.

        Args:
            user_id: The authenticated owner; every account and its movements are
                scoped to it so a caller only sees their own (ADR-108, ADR-131).
            months: The requested number of months, ending at the current month;
                clamped to the supported window.

        Returns:
            The assembled :class:`NetWorthHistory`, oldest-first.
        """
