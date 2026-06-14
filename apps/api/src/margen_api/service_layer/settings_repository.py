"""Repository port for the single-row application settings write side (ADR-054).

The settings are persisted to a single ``app_settings`` row (no per-user key yet,
ADR-054). The write path goes exclusively through this port from the update
handler, on the unit of work, so the change commits transactionally. The port
also exposes a focused read so the handler can return the resulting settings
after the write. Concrete adapters live under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.settings_read_models import AppSettings


class AbstractSettingsRepository(ABC):
    """Async store for the single-row application settings (ADR-054)."""

    @abstractmethod
    async def get_settings(self) -> AppSettings:
        """Return the persisted settings, falling back to the defaults.

        Returns:
            The single-row :class:`AppSettings`; the documented defaults
            (ARS / MEP / category ``C`` / services) when no row exists yet.
        """

    @abstractmethod
    async def upsert_settings(
        self,
        *,
        preferred_display_currency: str | None = None,
        fx_default_rate_type: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
    ) -> AppSettings:
        """Merge the provided fields onto the single settings row (ADR-054).

        Updates only the fields passed as non-``None`` (a partial PATCH leaves the
        others untouched). Creates the row from the documented defaults when it is
        somehow absent so the write never silently no-ops.

        Args:
            preferred_display_currency: The 3-letter currency code to persist, or
                ``None`` to leave it unchanged.
            fx_default_rate_type: The FX rate-type token to persist, or ``None`` to
                leave it unchanged.
            monotributo_current_category: The category letter A-K to persist, or
                ``None`` to leave it unchanged.
            monotributo_activity_type: The activity type to persist, or ``None`` to
                leave it unchanged.

        Returns:
            The resulting :class:`AppSettings` after the merge.
        """
