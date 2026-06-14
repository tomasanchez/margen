"""Reader port for the Monotributo query side (ADR-047, ADR-052).

The reader serves the Monotributo page: a live trailing-12-month standing, the
prior-window comparison, the A-K scale, and the included-invoice drilldown. It is
strictly read-only — the read-records snapshot write goes through a command on the
unit of work (ADR-052), never through this port. The concrete adapter lives under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from margen_api.service_layer.monotributo_read_models import (
    MonotributoSnapshot,
    MonotributoStanding,
)


class AbstractMonotributoReader(ABC):
    """Async, read-only query port for the Monotributo page (ADR-047)."""

    @abstractmethod
    async def snapshot(self, reference: date) -> MonotributoSnapshot:
        """Build the full Monotributo page snapshot for a reference date (ADR-052).

        Computes the live current standing from transactions, attaches the A-K
        scale and the included-invoice drilldown, and resolves the ``previous``
        prior-window standing — read from a persisted snapshot when one exists for
        that period, otherwise computed live as a fallback.

        Args:
            reference: The reference date (server "today"); the trailing-12-month
                window ends here.

        Returns:
            The assembled :class:`MonotributoSnapshot`.
        """

    @abstractmethod
    async def current_standing(self, reference: date) -> MonotributoStanding:
        """Compute only the live trailing-12-month standing (ADR-046).

        Used by the capture command to derive the figures it persists, so the
        write path reuses the same read-side aggregation.

        Args:
            reference: The reference date the trailing window ends at.

        Returns:
            The live :class:`MonotributoStanding` for the window ending at
            ``reference``.
        """
