"""Boundary schemas for the reports contract (ADR-163, ADR-164, ADR-030).

Translates the query-side :class:`NetWorthHistory` read model into the camelCase
JSON the Reports page expects (ADR-030) — a ``months`` series wrapped in the
``ResponseModel`` envelope. Each point carries the NATIVE per-currency subtotals
(``arsTotal`` / ``usdTotal``): the backend performs no FX conversion, the frontend
converts at the live MEP rate (ADR-164). Money is serialized as ``Decimal`` exactly
as the rest of the app does (ADR-025).
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field

from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.reports_read_models import NetWorthHistory, NetWorthHistoryPoint


class NetWorthHistoryPointResponse(CamelCaseModel):
    """One month's cumulative month-END native net balance per currency (ADR-164)."""

    month: str = Field(description="Calendar month as 'YYYY-MM'.")
    ars_total: Decimal = Field(description="Cumulative native ARS balance at month-end; 0 when none.")
    usd_total: Decimal = Field(description="Cumulative native USD balance at month-end; 0 when none.")

    @classmethod
    def from_read_model(cls, model: NetWorthHistoryPoint) -> NetWorthHistoryPointResponse:
        """Build the response point from a history read model."""
        return cls(month=model.month, ars_total=model.ars_total, usd_total=model.usd_total)


class NetWorthHistoryResponse(CamelCaseModel):
    """The net-worth history series for the Reports page (ADR-164)."""

    months: list[NetWorthHistoryPointResponse] = Field(
        description="Per-month native subtotals, oldest-first, ending at the current month.",
    )

    @classmethod
    def from_read_model(cls, model: NetWorthHistory) -> NetWorthHistoryResponse:
        """Build the response from a net-worth history read model (ADR-030)."""
        return cls(months=[NetWorthHistoryPointResponse.from_read_model(point) for point in model.months])
