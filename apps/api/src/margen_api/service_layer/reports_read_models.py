"""Read models for the reports query side (ADR-163, ADR-164).

Purpose-built, immutable DTOs for the Reports page's net-worth history series —
deliberately separate from the account write aggregate so the two evolve
independently (AGENTS.md reader ports + read models). Money is
:class:`~decimal.Decimal` (ADR-025). The series carries per-currency NATIVE
subtotals (no server-side FX, ADR-164): the frontend converts each month's
``(ars_total, usd_total)`` pair at the single live MEP rate it already holds.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class NetWorthHistoryPoint:
    """One calendar month's cumulative month-END net balance per currency (ADR-164).

    Attributes:
        month: Calendar month as ``YYYY-MM``.
        ars_total: Cumulative native ARS balance across the owner's ARS accounts at
            the END of ``month`` (opening balances + signed transaction deltas +
            net transfer flow up to and including the month, ADR-122/135); ``0``
            when the owner holds no ARS.
        usd_total: Cumulative native USD balance across the owner's USD accounts at
            the END of ``month`` (ADR-123); ``0`` when the owner holds no USD.
    """

    month: str
    ars_total: Decimal
    usd_total: Decimal


@dataclass(frozen=True, slots=True)
class NetWorthHistory:
    """The net-worth history series for the reports page (ADR-164).

    Attributes:
        months: The per-month points, oldest-first, covering the requested window
            ending at the current calendar month. Each carries the cumulative
            month-END native subtotals per currency; the frontend converts them at
            the live MEP rate (ADR-164).
    """

    months: list[NetWorthHistoryPoint]
