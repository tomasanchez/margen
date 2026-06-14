"""Repository port for the single-row Monotributo config write side (ADR-048).

The configured category is persisted to a single ``monotributo_config`` row
(no per-user key yet, ADR-048). The config write path goes exclusively through
this port from the update handler, on the unit of work, so the change commits
transactionally. The port also exposes a focused read so the endpoint can return
the persisted values after the write. Concrete adapters live under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class AbstractMonotributoConfigRepository(ABC):
    """Async store for the single-row Monotributo configuration (ADR-048)."""

    @abstractmethod
    async def set_config(self, *, current_category: str, activity_type: str | None) -> None:
        """Upsert the configured category on the single config row (ADR-048).

        Updates ``current_category`` on the single row, and ``activity_type`` only
        when ``activity_type`` is not ``None`` (so a partial PATCH leaves the
        activity untouched). Creates the row when it is somehow absent so the
        write never silently no-ops.

        Args:
            current_category: The normalized category letter A-K to persist.
            activity_type: The activity type to persist, or ``None`` to leave the
                existing value unchanged.
        """

    @abstractmethod
    async def get_config(self) -> tuple[str, str] | None:
        """Return the persisted ``(current_category, activity_type)`` pair, if set.

        Returns:
            The single-row config as a ``(current_category, activity_type)`` pair,
            or ``None`` when no config row exists.
        """
