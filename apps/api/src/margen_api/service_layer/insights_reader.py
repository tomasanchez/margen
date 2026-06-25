"""Reader port for the monthly insights query side (ADR-060, ADR-061).

The reader serves the Home Insights card and returns a :class:`MonthlyInsights`
DTO of structured facts rather than write aggregates. Keeping it separate from the
repository lets the query path use server-side SQL aggregation tuned for reads
(AGENTS.md). The concrete adapter lives under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.service_layer.insights_read_models import MonthlyInsights


class AbstractInsightsReader(ABC):
    """Async query port returning the structured monthly insight facts."""

    @abstractmethod
    async def monthly_insights(self, month: date, reference: date, user_id: str) -> MonthlyInsights:
        """Aggregate the structured insight facts for a month (ADR-060, ADR-061, ADR-108).

        Args:
            month: The first day of the requested calendar month; only its year
                and month are significant.
            reference: The server "today" used to project the current month's
                savings to month-end. For a past month it has no effect.
            user_id: The authenticated owner. The insights derive entirely from
                the caller's transactions, so every source query filters by it —
                the read model itself carries no ownership column (ADR-108,
                ADR-112).

        Returns:
            The :class:`MonthlyInsights` facts: the biggest positive category
            mover versus the prior month, the recurring-expense footprint, the
            actual-or-projected savings, and the latest USD transaction with an
            applied rate -- each ``None`` when its data does not exist (savings
            excepted). The frontend formats these facts itself.
        """
