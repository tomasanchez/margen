"""Boundary schemas for the debts REST contract (ADR-187, ADR-130, ADR-183).

These Pydantic models translate the debt read models to and from the camelCase JSON the
frontend builds to (the pinned contract). Money crosses the boundary as a decimal string
exactly as the rest of the app serializes ``Decimal`` (ADR-025, ADR-030). ``currency``
reuses the domain value object so the contract stays aligned with the aggregate.

Pinned JSON contract:

* Debt = ``{ id, name, currency: 'ARS'|'USD', currentBalance: string,
  monthlyMinimum: string | null, rate: string | null }``
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.debt import CreateDebt, UpdateDebt
from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.debt_read_models import DebtReadModel


class DebtResponse(CamelCaseModel):
    """The debt shape returned to clients (ADR-187)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="Required human display label for the debt.")
    currency: Currency = Field(description="The debt's native currency: ARS or USD (ADR-183).")
    current_balance: Decimal = Field(
        description="The outstanding native-currency amount owed; a decimal string (ADR-025).",
    )
    monthly_minimum: Decimal | None = Field(
        default=None,
        description="Optional minimum monthly payment in the debt's native currency; a string or null (ADR-187).",
    )
    rate: Decimal | None = Field(
        default=None,
        description="Optional interest rate; a string or null (ADR-187).",
    )

    @classmethod
    def from_read_model(cls, model: DebtReadModel) -> DebtResponse:
        """Build the response from a query-side read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            currency=model.currency,
            current_balance=model.current_balance,
            monthly_minimum=model.monthly_minimum,
            rate=model.rate,
        )


class DebtCreateRequest(CamelCaseModel):
    """Request body for ``POST /debts`` (maps to :class:`CreateDebt`).

    Lenient validation (ADR-031): only true invariant violations are rejected here (empty
    ``name``, unknown ``currency``, negative ``currentBalance``). ``currentBalance``
    defaults to ``0`` and must be non-negative (a debt is a non-negative obligation,
    ADR-187). ``monthlyMinimum`` and ``rate`` are optional extension points (ADR-187).
    """

    name: str = Field(min_length=1, description="Required human display label.")
    currency: Currency = Field(default=Currency.ARS, description="Native currency: ARS or USD (ADR-183).")
    current_balance: Decimal = Field(
        default=Decimal(0),
        ge=Decimal(0),
        description="The non-negative native-currency outstanding amount; defaults to 0 (ADR-187).",
    )
    monthly_minimum: Decimal | None = Field(default=None, description="Optional minimum monthly payment.")
    rate: Decimal | None = Field(default=None, description="Optional interest rate.")

    def to_command(self, user_id: str) -> CreateDebt:
        """Translate the request into a :class:`CreateDebt` command.

        Args:
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps onto
                the command so the created debt is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return CreateDebt(
            user_id=user_id,
            name=self.name,
            currency=self.currency,
            current_balance=self.current_balance,
            monthly_minimum=self.monthly_minimum,
            rate=self.rate,
        )


class DebtPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /debts/{id}`` (maps to :class:`UpdateDebt`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028). ``currentBalance``, when present, must be non-negative (ADR-187).
    """

    name: str | None = Field(default=None, min_length=1, description="New display label.")
    currency: Currency | None = Field(default=None, description="New native currency.")
    current_balance: Decimal | None = Field(
        default=None,
        ge=Decimal(0),
        description="New non-negative native-currency outstanding amount.",
    )
    monthly_minimum: Decimal | None = Field(default=None, description="New minimum monthly payment.")
    rate: Decimal | None = Field(default=None, description="New interest rate.")

    def to_command(self, debt_id: UUID, user_id: str) -> UpdateDebt:
        """Translate the patch into an :class:`UpdateDebt` command.

        Args:
            debt_id: The identity from the URL path.
            user_id: The authenticated owner (``AuthUser.id``) the handler scopes the
                load/persist by, so a cross-tenant patch is a 404 (ADR-111).

        Returns:
            The command addressing one aggregate; ``None`` fields are left unchanged.
        """
        return UpdateDebt(
            id=debt_id,
            user_id=user_id,
            name=self.name,
            currency=self.currency,
            current_balance=self.current_balance,
            monthly_minimum=self.monthly_minimum,
            rate=self.rate,
        )
