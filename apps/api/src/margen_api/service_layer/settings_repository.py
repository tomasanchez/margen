"""Repository port for the per-user application settings write side (ADR-054, ADR-110).

The settings are persisted to one ``app_settings`` row per user (ADR-110). The
write path goes exclusively through this port from the update handler, on the
unit of work, so the change commits transactionally. The port also exposes a
focused read so the handler can return the resulting settings after the write.
Concrete adapters live under ``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from margen_api.service_layer.settings_read_models import AppSettings


class AbstractSettingsRepository(ABC):
    """Async store for the per-user application settings (ADR-054, ADR-110)."""

    @abstractmethod
    async def get_settings(self, user_id: str) -> AppSettings:
        """Return the owner's persisted settings, falling back to the defaults.

        Args:
            user_id: The owner whose settings row is read (ADR-108, ADR-110).

        Returns:
            The owner's :class:`AppSettings`; the documented defaults
            (ARS / MEP / category ``C`` / services) when the owner has no row yet.
        """

    @abstractmethod
    async def upsert_settings(
        self,
        user_id: str,
        *,
        preferred_display_currency: str | None = None,
        fx_default_rate_type: str | None = None,
        preferred_rate_source: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
        monotributo_enabled: bool | None = None,
    ) -> AppSettings:
        """Merge the provided fields onto the owner's settings row (ADR-054, ADR-110).

        Updates only the fields passed as non-``None`` (a partial PATCH leaves the
        others untouched). Get-or-creates the owner's row from the documented
        defaults (scoped to ``user_id``) when none exists so the write never
        silently no-ops (ADR-110).

        Args:
            user_id: The owner whose settings row is created or updated (ADR-108,
                ADR-110).
            preferred_display_currency: The 3-letter currency code to persist, or
                ``None`` to leave it unchanged.
            fx_default_rate_type: The FX rate-type token to persist, or ``None`` to
                leave it unchanged.
            preferred_rate_source: The preferred FX rate source to persist
                (``"bolsa"`` / ``"oficial"``, ADR-151), or ``None`` to leave it
                unchanged.
            monotributo_current_category: The category letter A-K to persist, or
                ``None`` to leave it unchanged.
            monotributo_activity_type: The activity type to persist, or ``None`` to
                leave it unchanged.
            monotributo_enabled: Whether the optional Monotributo module is enabled
                (ADR-126), or ``None`` to leave it unchanged.

        Returns:
            The resulting :class:`AppSettings` after the merge.
        """
