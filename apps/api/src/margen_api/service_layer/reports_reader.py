"""Reader port for the reports query side (ADR-163, ADR-164, ADR-169).

The reader serves the Reports page's net-worth history series and the range-based
overview, and is strictly read-only — no writes flow through it. It is owner-scoped
so a caller only ever sees their own data (ADR-130, ADR-131). The concrete adapter
lives under ``margen_api.adapters``. The net-worth-history and CSV-export surfaces
are retained; the redesigned overview replaces ADR-163's multi-reader fan-out with
a single range-scoped query (ADR-167).
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.net_worth_history import DEFAULT_MONTHS
from margen_api.service_layer.reports_overview_read_models import ReportsOverview
from margen_api.service_layer.reports_read_models import NetWorthHistory


class AbstractReportsReader(ABC):
    """Async, read-only query port for the reports surfaces (ADR-164, ADR-169)."""

    @abstractmethod
    async def overview(
        self,
        user_id: str,
        *,
        range_key: str,
        currency: Currency = Currency.ARS,
    ) -> ReportsOverview:
        """Return the owner's range-based Reports overview (ADR-167, ADR-169, ADR-131).

        Resolves ``range_key`` into the current month-window ending at the current
        month and the immediately-preceding equal-length window, and assembles the
        KPI strip, cash-flow series, category trends and FX summary. Every figure is
        denominated in ``currency`` (ADR-168): the ARS path sums the authoritative
        ``amount``; the USD path sums the ``usd_amount`` snapshot, excludes rows that
        lack one and surfaces their count as ``unconverted`` (ADR-152). Scoped to
        ``user_id`` so a caller only sees their own data (ADR-108, ADR-131).

        Args:
            user_id: The authenticated owner; every aggregate is scoped to it.
            range_key: One of ``3M``, ``6M``, ``12M``, ``YTD``.
            currency: The denomination currency; ``ARS`` (default) or ``USD``.

        Returns:
            The assembled :class:`ReportsOverview`.
        """

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
