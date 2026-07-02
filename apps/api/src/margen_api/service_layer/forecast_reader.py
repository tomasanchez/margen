"""Reader port for the cash-flow forecast query side (ADR-176, ADR-177).

The reader serves the schedule/commitment-driven forecast and is strictly read-only —
no writes flow through it. It is owner-scoped so a caller only ever sees their own
committed streams (ADR-108, ADR-131). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.domain.models.value_objects import Currency
from margen_api.service_layer.forecast import DEFAULT_HORIZON
from margen_api.service_layer.forecast_read_models import ForecastSeries


class AbstractForecastReader(ABC):
    """Async, read-only query port for the cash-flow forecast (ADR-176, ADR-177)."""

    @abstractmethod
    async def forecast(
        self,
        user_id: str,
        *,
        horizon: int = DEFAULT_HORIZON,
        currency: Currency = Currency.ARS,
    ) -> ForecastSeries:
        """Return the owner's committed-outflow cash-flow forecast (ADR-176, ADR-177, ADR-131).

        Projects a forward per-month series over ``horizon`` months (clamped ``1..12``,
        starting the month AFTER the current month) of COMMITTED outflows only:
        flagged recurring subscription streams (projected on their cadence), instalment
        tails (remaining cuotas), and the configured monotributo monthly cuota (ADR-177).
        A stream projects only into months strictly after its latest actual occurrence,
        so actuals own the past and projection owns the future (no double-count, ADR-176).

        Every figure is denominated in ``currency`` (ADR-168): the ARS path sums the
        authoritative ``amount``; the USD path sums the ``usd_amount`` snapshot, excludes
        rows that lack one and surfaces their count as ``unconverted`` (ADR-152). Scoped
        to ``user_id`` so a caller only sees their own commitments (ADR-108, ADR-131).

        Args:
            user_id: The authenticated owner; every committed stream is scoped to it.
            horizon: The requested number of forward months; clamped to ``1..12``.
            currency: The denomination currency; ``ARS`` (default) or ``USD``.

        Returns:
            The assembled :class:`ForecastSeries`.
        """
