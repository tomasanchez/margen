"""Boundary schemas for the accounts + net-worth REST contract (ADR-122, ADR-123).

These Pydantic models translate the account read models to and from the camelCase
JSON the frontend will build to (the pinned contract). Money crosses the boundary
as a decimal string exactly as the rest of the app serializes ``Decimal`` (ADR-025,
ADR-030). ``type`` and ``currency`` reuse the domain value objects so the contract
stays aligned with the aggregate.

Pinned JSON contract:

* Account = ``{ id, name, type: 'bank'|'cash'|'card', currency: 'ARS'|'USD',
  openingBalance: string }``
* Net worth = ``{ total: string, currency, accounts: [{ id, name, currency,
  balance: string, balanceConverted: string }] }``
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.models.value_objects import AccountType, Currency
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.account_read_models import (
    AccountBalance,
    AccountReadModel,
    NetWorth,
)


class AccountResponse(CamelCaseModel):
    """The account shape returned to clients (ADR-122)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    name: str = Field(description="Required human display label for the account.")
    type: AccountType = Field(description="Account kind: bank / cash / card.")
    currency: Currency = Field(description="The account's native currency: ARS or USD (ADR-123).")
    opening_balance: Decimal = Field(
        description="The native-currency balance before any transaction; a decimal string (ADR-025).",
    )

    @classmethod
    def from_read_model(cls, model: AccountReadModel) -> AccountResponse:
        """Build the response from a query-side read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            type=model.type,
            currency=model.currency,
            opening_balance=model.opening_balance,
        )


class AccountCreateRequest(CamelCaseModel):
    """Request body for ``POST /accounts`` (maps to :class:`CreateAccount`).

    Lenient validation (ADR-031): only true invariant violations are rejected here
    (empty ``name``, unknown ``type`` / ``currency``). ``openingBalance`` defaults
    to ``0`` and may be negative (a card account opened with a balance, ADR-122).
    """

    name: str = Field(min_length=1, description="Required human display label.")
    type: AccountType = Field(description="Account kind: bank / cash / card.")
    currency: Currency = Field(default=Currency.ARS, description="Native currency: ARS or USD (ADR-123).")
    opening_balance: Decimal = Field(
        default=Decimal(0),
        description="The native-currency opening balance; defaults to 0 (ADR-124).",
    )

    def to_command(self, user_id: str) -> CreateAccount:
        """Translate the request into a :class:`CreateAccount` command.

        Args:
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the created account is owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return CreateAccount(
            user_id=user_id,
            name=self.name,
            type=self.type,
            currency=self.currency,
            opening_balance=self.opening_balance,
        )


class AccountPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /accounts/{id}`` (maps to :class:`UpdateAccount`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028).
    """

    name: str | None = Field(default=None, min_length=1, description="New display label.")
    type: AccountType | None = Field(default=None, description="New account kind.")
    currency: Currency | None = Field(default=None, description="New native currency.")
    opening_balance: Decimal | None = Field(default=None, description="New native-currency opening balance.")

    def to_command(self, account_id: UUID, user_id: str) -> UpdateAccount:
        """Translate the patch into an :class:`UpdateAccount` command.

        Args:
            account_id: The identity from the URL path.
            user_id: The authenticated owner (``AuthUser.id``) the handler scopes
                the load/persist by, so a cross-tenant patch is a 404 (ADR-111).

        Returns:
            The command addressing one aggregate; ``None`` fields are left unchanged.
        """
        return UpdateAccount(
            id=account_id,
            user_id=user_id,
            name=self.name,
            type=self.type,
            currency=self.currency,
            opening_balance=self.opening_balance,
        )


class AccountBalanceResponse(CamelCaseModel):
    """One account's balance in the net-worth breakdown (ADR-122, ADR-123)."""

    id: UUID = Field(description="The account's stable UUID identity.")
    name: str = Field(description="The account's display label.")
    currency: Currency = Field(description="The account's native currency (ADR-123).")
    balance: Decimal = Field(description="The native-currency balance; a decimal string (ADR-025).")
    balance_converted: Decimal = Field(
        description="The balance converted into the display currency via MEP FX; a decimal string (ADR-123).",
    )

    @classmethod
    def from_read_model(cls, model: AccountBalance) -> AccountBalanceResponse:
        """Build the response from an account-balance read model (ADR-030)."""
        return cls(
            id=model.id,
            name=model.name,
            currency=model.currency,
            balance=model.balance,
            balance_converted=model.balance_converted,
        )


class NetWorthResponse(CamelCaseModel):
    """The net-worth surface returned to clients (ADR-122, ADR-123)."""

    total: Decimal = Field(description="The sum of every account's converted balance; a decimal string.")
    currency: Currency = Field(description="The display currency the total is expressed in (ADR-056).")
    accounts: list[AccountBalanceResponse] = Field(description="The per-account breakdown.")

    @classmethod
    def from_read_model(cls, model: NetWorth) -> NetWorthResponse:
        """Build the response from a net-worth read model (ADR-030)."""
        return cls(
            total=model.total,
            currency=model.currency,
            accounts=[AccountBalanceResponse.from_read_model(item) for item in model.accounts],
        )
