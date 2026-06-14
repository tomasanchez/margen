"""Boundary schemas for the Monotributo contract (ADR-047, ADR-052, ADR-030).

These Pydantic models translate the query-side :class:`MonotributoSnapshot` read
model into the camelCase JSON the Monotributo page expects: a ``current`` standing,
an optional ``previous`` standing for the comparison toggle, the A-K ``scale``
table, and the included-invoice ``invoices`` drilldown — wrapped in the
``ResponseModel`` envelope. Money is serialized as ``Decimal`` exactly as the
transactions endpoint does (ADR-025), so the frontend parses one number style.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.monotributo import UpdateMonotributoConfig
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoScaleEntry,
    MonotributoSnapshot,
    MonotributoStanding,
)


class MonotributoStandingResponse(CamelCaseModel):
    """A trailing-12-month standing for the Monotributo page (ADR-046)."""

    category: str = Field(description="Category letter (A-K) in effect for the window.")
    activity_type: str = Field(description="'services' or 'bienes' (MVP uses services).")
    limit: Decimal = Field(description="The category's annual ceiling in ARS.")
    used: Decimal = Field(description="SUM of included invoices over the trailing window.")
    remaining: Decimal = Field(description="limit - used; may be negative when over the limit.")
    percent_used: Decimal = Field(description="used / limit * 100; 0 when limit is 0.")
    status: str = Field(description="Status band key: safe / watch / close / over.")
    projected_category: str = Field(description="Projected landing category from linear annualization.")
    projection_note: str = Field(description="Plain-language note labeling the projection an estimate.")
    period_start: date = Field(description="First day of the trailing-12-month window.")
    period_end: date = Field(description="Last day of the trailing-12-month window.")

    @classmethod
    def from_read_model(cls, model: MonotributoStanding) -> MonotributoStandingResponse:
        """Build the response standing from a read model."""
        return cls(
            category=model.category,
            activity_type=model.activity_type,
            limit=model.limit,
            used=model.used,
            remaining=model.remaining,
            percent_used=model.percent_used,
            status=model.status,
            projected_category=model.projected_category,
            projection_note=model.projection_note,
            period_start=model.period_start,
            period_end=model.period_end,
        )


class MonotributoScaleEntryResponse(CamelCaseModel):
    """One A-K reference row in the Monotributo scale table (ADR-048)."""

    letter: str = Field(description="Category letter, 'A' through 'K'.")
    annual_ceiling: Decimal = Field(description="Maximum trailing-12-month gross income for the category.")
    cuota_servicios: Decimal = Field(description="Monthly all-in cuota for a services taxpayer.")
    cuota_bienes: Decimal = Field(description="Monthly all-in cuota for a goods taxpayer.")

    @classmethod
    def from_read_model(cls, model: MonotributoScaleEntry) -> MonotributoScaleEntryResponse:
        """Build the response entry from a scale read model."""
        return cls(
            letter=model.letter,
            annual_ceiling=model.annual_ceiling,
            cuota_servicios=model.cuota_servicios,
            cuota_bienes=model.cuota_bienes,
        )


class MonotributoInvoiceResponse(CamelCaseModel):
    """One included invoice in the trailing-12-month drilldown (ADR-046)."""

    id: UUID = Field(description="The transaction identity.")
    occurred_on: date = Field(description="Calendar date the invoice happened.")
    name: str = Field(description="Human display label.")
    category: str | None = Field(default=None, description="Category label, or null when uncategorized.")
    amount: Decimal = Field(description="ARS-equivalent magnitude that counted toward the limit.")
    currency: str = Field(description="Original currency of the row (ARS or USD).")
    cumulative: Decimal = Field(description="Running SUM of amount through this row, oldest-first.")
    is_foreign_currency: bool = Field(description="Whether the row was originally in a non-ARS currency.")

    @classmethod
    def from_read_model(cls, model: MonotributoInvoice) -> MonotributoInvoiceResponse:
        """Build the response invoice from a drilldown read model."""
        return cls(
            id=model.id,
            occurred_on=model.occurred_on,
            name=model.name,
            category=model.category,
            amount=model.amount,
            currency=model.currency,
            cumulative=model.cumulative,
            is_foreign_currency=model.is_foreign_currency,
        )


class MonotributoSnapshotResponse(CamelCaseModel):
    """The full Monotributo page payload (ADR-052)."""

    current: MonotributoStandingResponse = Field(description="The live trailing-12-month standing.")
    previous: MonotributoStandingResponse | None = Field(
        default=None,
        description="The prior trailing-12-month standing for comparison; null when no data exists.",
    )
    scale: list[MonotributoScaleEntryResponse] = Field(description="The A-K reference scale rows.")
    invoices: list[MonotributoInvoiceResponse] = Field(
        description="The included-invoice drilldown, oldest-first with a running cumulative.",
    )

    @classmethod
    def from_read_model(cls, model: MonotributoSnapshot) -> MonotributoSnapshotResponse:
        """Build the response from a snapshot read model (ADR-030)."""
        return cls(
            current=MonotributoStandingResponse.from_read_model(model.current),
            previous=(
                MonotributoStandingResponse.from_read_model(model.previous) if model.previous is not None else None
            ),
            scale=[MonotributoScaleEntryResponse.from_read_model(entry) for entry in model.scale],
            invoices=[MonotributoInvoiceResponse.from_read_model(invoice) for invoice in model.invoices],
        )


class MonotributoCaptureResponse(CamelCaseModel):
    """Acknowledgement for a Monotributo snapshot capture (ADR-052)."""

    status: str = Field(default="captured", description="Capture acknowledgement status.")


class MonotributoConfigUpdateRequest(CamelCaseModel):
    """PATCH body to set the configured Monotributo category (ADR-048).

    ``currentCategory`` is required; ``activityType`` is optional and, when
    omitted, leaves the persisted activity unchanged. The category letter is
    validated against the AFIP scale in the handler (an unknown letter yields a
    ``422``).
    """

    current_category: str = Field(
        min_length=1,
        description="Category letter A-K to set as the current Monotributo category.",
    )
    activity_type: str | None = Field(
        default=None,
        description="Activity type ('services' or 'bienes'); omit to leave unchanged.",
    )

    def to_command(self) -> UpdateMonotributoConfig:
        """Translate the request into the boundary-agnostic command."""
        return UpdateMonotributoConfig(
            current_category=self.current_category,
            activity_type=self.activity_type,
        )


class MonotributoConfigResponse(CamelCaseModel):
    """The persisted single-row Monotributo config after a write (ADR-048)."""

    current_category: str = Field(description="The configured category letter A-K now in effect.")
    activity_type: str = Field(description="The configured activity type ('services' or 'bienes').")

    @classmethod
    def from_persisted(cls, *, current_category: str, activity_type: str) -> MonotributoConfigResponse:
        """Build the response from the persisted config pair."""
        return cls(current_category=current_category, activity_type=activity_type)
