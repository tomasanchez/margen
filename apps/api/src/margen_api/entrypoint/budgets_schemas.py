"""Boundary schemas for the budgets REST contract (ADR-125, ADR-030).

These Pydantic models translate the budgets read model to and from the JSON the
frontend builds to (the pinned contract). Money crosses the boundary as a decimal
string exactly as the rest of the app serializes ``Decimal`` (ADR-025, ADR-030).
``target`` and ``remaining`` are nullable: a category with no target reads back
``null`` for both (ADR-125). The upsert body carries the ``YYYY-MM`` month the
entrypoint parses into a period (ADR-040), mirroring the summaries month-navigator
contract.

Pinned JSON contract:

* GET ``/budgets?month=YYYY-MM`` -> ``{ month: 'YYYY-MM', currency: 'ARS',
  categories: [{ category, target: string|null, spent: string,
  remaining: string|null }] }``
* PUT ``/budgets`` body ``{ category, month: 'YYYY-MM', amount: string,
  currency?: 'ARS' }``
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import Field

from margen_api.domain.commands.budget import UpsertBudget
from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.budget_read_models import BudgetLine, MonthlyBudget


class BudgetLineResponse(CamelCaseModel):
    """One expense category's target vs actual for the month (ADR-125)."""

    category: str = Field(description="The expense category label.")
    target: Decimal | None = Field(
        default=None,
        description="The budget target for the category this month; null when unset (ADR-125).",
    )
    spent: Decimal = Field(description="The category's ARS-equivalent expense total for the month (ADR-042).")
    remaining: Decimal | None = Field(
        default=None,
        description="target - spent when a target is set; null otherwise (ADR-125).",
    )

    @classmethod
    def from_read_model(cls, model: BudgetLine) -> BudgetLineResponse:
        """Build the response line from a budget read model (ADR-030)."""
        return cls(
            category=model.category,
            target=model.target,
            spent=model.spent,
            remaining=model.remaining,
        )


class MonthlyBudgetResponse(CamelCaseModel):
    """The budgets-vs-actuals surface returned to clients (ADR-125)."""

    month: str = Field(description="The requested month as 'YYYY-MM'.")
    currency: Currency = Field(description="The currency targets and spend are expressed in; ARS for the MVP.")
    categories: list[BudgetLineResponse] = Field(
        description="One line per expense category, sorted by category name.",
    )

    @classmethod
    def from_read_model(cls, model: MonthlyBudget) -> MonthlyBudgetResponse:
        """Build the response from a monthly-budget read model (ADR-030)."""
        return cls(
            month=model.month,
            currency=model.currency,
            categories=[BudgetLineResponse.from_read_model(line) for line in model.categories],
        )


class BudgetUpsertRequest(CamelCaseModel):
    """Request body for ``PUT /budgets`` (maps to :class:`UpsertBudget`).

    Sets or replaces a category's target for a month (upsert, ADR-125). ``month`` is
    the ``YYYY-MM`` month-navigator period the entrypoint parses into the first day
    of the month (ADR-040). ``amount`` is a positive decimal string (ADR-025);
    ``currency`` defaults to ARS (the MVP target currency, ADR-125 currency note).
    """

    category: str = Field(description="The expense category the target applies to.", min_length=1)
    month: str = Field(description="The budget month as 'YYYY-MM'.")
    amount: Decimal = Field(description="The target spend for the category this month; a decimal string (ADR-025).")
    currency: Currency = Field(default=Currency.ARS, description="The target currency; ARS for the MVP (ADR-125).")

    def to_command(self, period: date, user_id: str) -> UpsertBudget:
        """Translate the request into an :class:`UpsertBudget` command.

        Args:
            period: The first day of the parsed ``month`` (the entrypoint parses the
                ``YYYY-MM`` string and validates it before dispatch).
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the target is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return UpsertBudget(
            user_id=user_id,
            category=self.category,
            period=period,
            amount=self.amount,
            currency=self.currency,
        )
