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
    async def configured_category(self, user_id: str) -> tuple[str, str] | None:
        """Return the owner's configured ``(category, activity_type)`` pair, if set (ADR-112).

        Args:
            user_id: The owner whose ``app_settings`` row is read (ADR-108).

        Returns:
            The owner's persisted config as a ``(category, activity_type)`` pair,
            or ``None`` when no config row exists yet (the caller supplies a
            sensible default).
        """

    @abstractmethod
    async def used_in_window(self, window_start: date, window_end: date, user_id: str) -> Decimal:
        """Return the SUM of the owner's included income over a trailing window (ADR-046, ADR-112).

        Sums the owner's transactions with ``kind in ('invoice', 'income')`` and
        ``counts_toward_monotributo = true`` whose ``occurred_on`` falls in the
        inclusive ``[window_start, window_end]`` range.

        Args:
            window_start: First day of the window.
            window_end: Last day of the window.
            user_id: The owner whose income is summed (ADR-108).

        Returns:
            The ARS-equivalent included income total; ``0`` when none.
        """

    @abstractmethod
    async def existing_period_ends(self, user_id: str) -> set[date]:
        """Return the owner's ``period_end`` months that already have a snapshot (ADR-112).

        Args:
            user_id: The owner whose snapshot history is scanned (ADR-108).

        Returns:
            The owner's persisted ``period_end`` dates (month-granular), used to
            decide which months still need a backfill row.
        """

    @abstractmethod
    async def upsert(self, standing: MonotributoStanding, user_id: str) -> None:
        """Idempotently insert or update the owner's snapshot for a ``period_end`` (ADR-052, ADR-112).

        Keyed by ``(user_id, period_end)``: updates the owner's existing row when
        one exists for that month, otherwise inserts a new one attributed to the
        owner. Concurrent reads in the same month converge to the same row.

        Args:
            standing: The computed standing to freeze as a snapshot row.
            user_id: The owner the snapshot is attributed to (ADR-108).
        """
