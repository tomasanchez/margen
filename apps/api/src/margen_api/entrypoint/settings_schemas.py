"""Boundary schemas for the application settings contract (ADR-054, ADR-030).

These Pydantic models translate between the camelCase JSON the settings surface
exchanges and the query-side :class:`AppSettings` read model / the
:class:`UpdateSettings` command. The PATCH request is all-optional (a partial
update); the response echoes the four settings as camelCase fields, wrapped in
the ``ResponseModel`` envelope. No money lives in settings -- the display
currency is a frontend display preference (ADR-056).
"""

from __future__ import annotations

from pydantic import Field

from margen_api.domain.commands.settings import UpdateSettings
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.settings_read_models import AppSettings


class SettingsUpdateRequest(CamelCaseModel):
    """PATCH body to update the application settings (ADR-054).

    Every field is optional; only the provided ones are applied (a partial
    update). The values are validated in the handler -- the currency against
    ``{ARS, USD}``, the FX default against ``{MEP, official}``, and the category
    against the AFIP A-K scale -- and an unknown value maps to ``422`` (ADR-030).
    """

    preferred_display_currency: str | None = Field(
        default=None,
        description="Display currency ('ARS' or 'USD'); omit to leave unchanged.",
    )
    fx_default_rate_type: str | None = Field(
        default=None,
        description="Default FX rate type ('MEP' or 'official'); omit to leave unchanged.",
    )
    preferred_rate_source: str | None = Field(
        default=None,
        description="Preferred FX rate source ('bolsa' or 'oficial'); omit to leave unchanged (ADR-151).",
    )
    monotributo_current_category: str | None = Field(
        default=None,
        description="Monotributo category letter A-K; omit to leave unchanged.",
    )
    monotributo_activity_type: str | None = Field(
        default=None,
        description="Monotributo activity type ('services' or 'bienes'); omit to leave unchanged.",
    )
    monotributo_enabled: bool | None = Field(
        default=None,
        description="Whether the optional Monotributo module is enabled; omit to leave unchanged.",
    )

    def to_command(self, user_id: str) -> UpdateSettings:
        """Translate the request into the owner-stamped command (ADR-108, ADR-110).

        Args:
            user_id: The authenticated owner the update is scoped to; carried on
                the command so the handler get-or-creates and merges the owner's
                row (ADR-110).
        """
        return UpdateSettings(
            user_id=user_id,
            preferred_display_currency=self.preferred_display_currency,
            fx_default_rate_type=self.fx_default_rate_type,
            preferred_rate_source=self.preferred_rate_source,
            monotributo_current_category=self.monotributo_current_category,
            monotributo_activity_type=self.monotributo_activity_type,
            monotributo_enabled=self.monotributo_enabled,
        )


class SettingsResponse(CamelCaseModel):
    """The application settings payload (ADR-054)."""

    preferred_display_currency: str = Field(description="Display currency ('ARS' or 'USD').")
    fx_default_rate_type: str = Field(description="Default FX rate type ('MEP' or 'official').")
    preferred_rate_source: str = Field(description="Preferred FX rate source ('bolsa' or 'oficial') (ADR-151).")
    monotributo_current_category: str = Field(description="Monotributo category letter A-K in effect.")
    monotributo_activity_type: str = Field(description="Monotributo activity type ('services' or 'bienes').")
    monotributo_enabled: bool = Field(description="Whether the optional Monotributo module is enabled (ADR-126).")

    @classmethod
    def from_read_model(cls, model: AppSettings) -> SettingsResponse:
        """Build the response from a settings read model (ADR-030)."""
        return cls(
            preferred_display_currency=model.preferred_display_currency,
            fx_default_rate_type=model.fx_default_rate_type,
            preferred_rate_source=model.preferred_rate_source,
            monotributo_current_category=model.monotributo_current_category,
            monotributo_activity_type=model.monotributo_activity_type,
            monotributo_enabled=model.monotributo_enabled,
        )
