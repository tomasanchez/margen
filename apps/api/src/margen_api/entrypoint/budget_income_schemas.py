"""Boundary schemas for the budget-income REST contract (ADR-139, ADR-143, ADR-030).

Translate the net-income-base read model to and from the JSON the frontend builds
to. Money crosses the boundary as a decimal string (ADR-025, ADR-030). The floor is
a nested object (``amount`` + ``source``), both null when unset. The upsert body
carries the ``YYYY-MM`` month the entrypoint parses into a period (ADR-040).

Pinned JSON contract:

* GET ``/budget-income?month=YYYY-MM`` -> ``{ month, amount: string|null, currency,
  source: string|null, floor: { amount: string|null, source: string|null } }``
* PUT ``/budget-income`` body ``{ month, amount, currency?, floorAmount?,
  floorSource? }``
* GET ``/budget-income/suggested?month=YYYY-MM`` -> ``{ suggestedBase: string|null }``
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import Field

from margen_api.domain.commands.budget import UpsertBudgetIncome
from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.budget_income_read_models import BudgetIncomeReadModel


class IncomeFloorResponse(CamelCaseModel):
    """The household-floor sub-object of the income readout (ADR-143)."""

    amount: Decimal | None = Field(default=None, description="The essentials floor; null when unset.")
    source: str | None = Field(default=None, description="Floor provenance: 'manual' or 'computed'; null when unset.")


class BudgetIncomeResponse(CamelCaseModel):
    """The net-income-base + floor readout returned to clients (ADR-139, ADR-143)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    amount: Decimal | None = Field(default=None, description="The month's net spendable income; null when unset.")
    currency: Currency = Field(description="The base currency; ARS for the MVP (ADR-125).")
    source: str | None = Field(default=None, description="Income provenance: 'manual' or 'monotributo'; null unset.")
    floor: IncomeFloorResponse = Field(description="The household-floor readout (essentials the plan must cover).")

    @classmethod
    def from_read_model(cls, model: BudgetIncomeReadModel) -> BudgetIncomeResponse:
        """Build the response from the income read model (ADR-030)."""
        return cls(
            month=model.month,
            amount=model.amount,
            currency=model.currency,
            source=model.source,
            floor=IncomeFloorResponse(amount=model.floor_amount, source=model.floor_source),
        )


class BudgetIncomeUpsertRequest(CamelCaseModel):
    """Request body for ``PUT /budget-income`` (maps to :class:`UpsertBudgetIncome`).

    Sets or replaces a month's net-income base + household floor (upsert, ADR-139).
    ``amount`` is a decimal string (ADR-025); ``currency`` defaults to ARS (ADR-125).
    The optional ``floorAmount`` is the essentials floor with a ``floorSource`` of
    ``manual`` (user typed) or ``computed`` (Σ essential targets, ADR-143).
    """

    month: str = Field(description="The income month as 'YYYY-MM'.")
    amount: Decimal = Field(description="The month's net spendable income; a decimal string (ADR-025).")
    currency: Currency = Field(default=Currency.ARS, description="The base currency; ARS for the MVP (ADR-125).")
    floor_amount: Decimal | None = Field(default=None, description="The optional household floor (ADR-143).")
    floor_source: str = Field(default="manual", description="Floor provenance: 'manual' or 'computed' (ADR-143).")

    def to_command(self, period: date, user_id: str) -> UpsertBudgetIncome:
        """Translate the request into an :class:`UpsertBudgetIncome` command.

        Args:
            period: The first day of the parsed ``month``.
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the base is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return UpsertBudgetIncome(
            user_id=user_id,
            period=period,
            amount=self.amount,
            currency=self.currency.value,
            floor_amount=self.floor_amount,
            floor_source=self.floor_source,
        )


class SuggestedBaseResponse(CamelCaseModel):
    """Response for ``GET /budget-income/suggested`` (ADR-139)."""

    suggested_base: Decimal | None = Field(
        default=None,
        description="The conservative variable-income suggestion; null when <12 months of history.",
    )
