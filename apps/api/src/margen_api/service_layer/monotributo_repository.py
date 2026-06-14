"""Repository port for the Monotributo snapshot write side (ADR-052).

The snapshot history is written exclusively through this port from the capture
handler — the read endpoint stays read-only and the write happens on the unit of
work. The port also exposes the focused read helpers the handler needs to derive
what to persist (the configured category and the per-window included-income
total), so the write path can build a standing without reaching into the
query-side reader. Concrete adapters live under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date
from decimal import Decimal

from margen_api.service_layer.monotributo_read_models import MonotributoStanding


class AbstractMonotributoSnapshotRepository(ABC):
    """Async store for persisted trailing-12-month standings (ADR-052)."""

    @abstractmethod
    async def configured_category(self) -> tuple[str, str] | None:
        """Return the configured ``(category, activity_type)`` pair, if set.

        Returns:
            The persisted single-row config as a ``(category, activity_type)``
            pair, or ``None`` when no config row exists yet (the caller supplies a
            sensible default).
        """

    @abstractmethod
    async def used_in_window(self, window_start: date, window_end: date) -> Decimal:
        """Return the SUM of included income over a trailing window (ADR-046).

        Sums transactions with ``kind in ('invoice', 'income')`` and
        ``counts_toward_monotributo = true`` whose ``occurred_on`` falls in the
        inclusive ``[window_start, window_end]`` range.

        Args:
            window_start: First day of the window.
            window_end: Last day of the window.

        Returns:
            The ARS-equivalent included income total; ``0`` when none.
        """

    @abstractmethod
    async def existing_period_ends(self) -> set[date]:
        """Return the set of ``period_end`` months that already have a snapshot.

        Returns:
            The persisted ``period_end`` dates (month-granular), used to decide
            which months still need a backfill row.
        """

    @abstractmethod
    async def upsert(self, standing: MonotributoStanding) -> None:
        """Idempotently insert or update the snapshot for a ``period_end`` (ADR-052).

        Keyed by the standing's ``period_end`` month: updates the existing row when
        one exists for that month, otherwise inserts a new one. Concurrent reads in
        the same month converge to the same row.

        Args:
            standing: The computed standing to freeze as a snapshot row.
        """
