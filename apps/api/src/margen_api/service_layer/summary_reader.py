"""Reader port for the monthly summaries query side (ADR-042).

The reader serves the Home spending trend and category breakdown panels and
returns a :class:`MonthlySummary` DTO rather than write aggregates. Keeping it
separate from the repository lets the query path use server-side SQL aggregation
tuned for reads (AGENTS.md). The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.service_layer.summary_read_models import MonthlySummary


class AbstractSummaryReader(ABC):
    """Async query port returning a monthly summary."""

    @abstractmethod
    async def monthly_summary(self, month: date, user_id: str) -> MonthlySummary:
        """Aggregate the trend and category breakdown for a month (ADR-042, ADR-108).

        Args:
            month: Any date within the requested calendar month; only its year
                and month are significant.
            user_id: The authenticated owner. The summary derives entirely from
                the caller's transactions, so every source query filters by it —
                the read model itself carries no ownership column (ADR-108,
                ADR-112).

        Returns:
            The 6-month expense trend ending at ``month`` (oldest-first, the
            requested month flagged ``current``) and the requested month's
            category breakdown (sorted by amount descending, with ``share`` and
            ``delta_pct`` versus the prior month).
        """
