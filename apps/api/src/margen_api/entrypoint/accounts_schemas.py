"""Boundary schemas for the accounts + net-worth REST contract (ADR-122, ADR-123, ADR-134).

These Pydantic models translate the account read models to and from the camelCase
JSON the frontend builds to (the pinned contract). Money crosses the boundary as a
decimal string exactly as the rest of the app serializes ``Decimal`` (ADR-025,
ADR-030). ``type`` and ``currency`` reuse the domain value objects so the contract
stays aligned with the aggregate. An account is a per-currency leaf under an
institution (ADR-134): a create carries the ``institutionId``, and responses carry
the institution's ``name`` + ``type`` denormalized for the client.

Pinned JSON contract:

* Account = ``{ id, institutionId, institutionName, type: 'bank'|'card'|'cash'|'wallet',
  currency: 'ARS'|'USD', openingBalance: string }``
* Net worth = ``{ total: string, currency, accounts: [{ id, institutionId,
  institutionName, type, currency, balance: string, balanceConverted: string }] }``
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.models.value_objects import Currency, InstitutionType
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.account_read_models import (
    AccountBalance,
    AccountReadModel,
    InstallmentsNative,
    Liabilities,
    NetWorth,
)


class AccountResponse(CamelCaseModel):
    """The account shape returned to clients (ADR-122, ADR-134)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    institution_id: UUID = Field(description="The owning institution's UUID (ADR-134).")
    institution_name: str = Field(description="The owning institution's display label (denormalized).")
    type: InstitutionType = Field(description="The owning institution's kind: bank / card / cash / wallet.")
    currency: Currency = Field(description="The account's native currency: ARS or USD (ADR-123).")
    opening_balance: Decimal = Field(
        description="The native-currency balance before any transaction; a decimal string (ADR-025).",
    )

    @classmethod
    def from_read_model(cls, model: AccountReadModel) -> AccountResponse:
        """Build the response from a query-side read model (ADR-030)."""
        return cls(
            id=model.id,
            institution_id=model.institution_id,
            institution_name=model.institution_name,
            type=model.type,
            currency=model.currency,
            opening_balance=model.opening_balance,
        )


class AccountCreateRequest(CamelCaseModel):
    """Request body for ``POST /accounts`` (maps to :class:`CreateAccount`).

    An account is created under one of the caller's institutions (ADR-134):
    ``institutionId`` is required and the name/type come from that institution.
    Lenient validation (ADR-031): only true invariant violations are rejected here
    (unknown ``currency``). ``openingBalance`` defaults to ``0`` and may be negative
    (a card account opened with a balance, ADR-122).
    """

    institution_id: UUID = Field(description="The owning institution's UUID (ADR-134).")
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
            institution_id=self.institution_id,
            currency=self.currency,
            opening_balance=self.opening_balance,
        )


class AccountPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /accounts/{id}`` (maps to :class:`UpdateAccount`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028). Reassigning ``institutionId`` re-checks ownership (ADR-130, ADR-134).
    """

    institution_id: UUID | None = Field(default=None, description="New owning institution UUID.")
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
            institution_id=self.institution_id,
            currency=self.currency,
            opening_balance=self.opening_balance,
        )


class AccountBalanceResponse(CamelCaseModel):
    """One account's balance in the net-worth breakdown (ADR-122, ADR-123, ADR-134)."""

    id: UUID = Field(description="The account's stable UUID identity.")
    institution_id: UUID = Field(description="The owning institution's UUID (ADR-134).")
    institution_name: str = Field(description="The owning institution's display label (denormalized).")
    type: InstitutionType = Field(description="The owning institution's kind: bank / card / cash / wallet.")
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
            institution_id=model.institution_id,
            institution_name=model.institution_name,
            type=model.type,
            currency=model.currency,
            balance=model.balance,
            balance_converted=model.balance_converted,
        )


class InstallmentsNativeResponse(CamelCaseModel):
    """The instalment tail as native ARS/USD sums, unconverted (ADR-183 amendment).

    The client converts these at the LIVE MEP rate it uses for the net-worth assets
    headline (ADR-133), so "Net of commitments" stays coherent when a USD tail exists.
    """

    ars: Decimal = Field(description="Sum of remaining x cuota over ARS instalment streams, native ARS; a string.")
    usd: Decimal = Field(description="Sum of remaining x cuota over USD instalment streams, native USD; a string.")

    @classmethod
    def from_read_model(cls, model: InstallmentsNative) -> InstallmentsNativeResponse:
        """Build the response from a native-breakdown read model (ADR-030)."""
        return cls(ars=model.ars, usd=model.usd)


class LiabilitiesResponse(CamelCaseModel):
    """The typed liabilities reservation returned to clients (ADR-180)."""

    installments: Decimal = Field(
        description="Full remaining instalment tail (sum of remaining x cuota) in the display currency; a string.",
    )
    installments_native: InstallmentsNativeResponse = Field(
        description="The instalment tail as native ARS/USD sums the client converts at the live rate (ADR-183).",
    )
    cc_balance: Decimal | None = Field(
        default=None,
        description="Unpaid credit-card balance liability; null in Slice 1, a typed placeholder (ADR-180).",
    )
    other: Decimal | None = Field(
        default=None,
        description="Catch-all for other debts; null in Slice 1, a typed placeholder (ADR-180).",
    )
    total: Decimal = Field(description="The sum of the present liability figures; a decimal string.")

    @classmethod
    def from_read_model(cls, model: Liabilities) -> LiabilitiesResponse:
        """Build the response from a liabilities read model (ADR-030)."""
        return cls(
            installments=model.installments,
            installments_native=InstallmentsNativeResponse.from_read_model(model.installments_native),
            cc_balance=model.cc_balance,
            other=model.other,
            total=model.total,
        )


class NetWorthResponse(CamelCaseModel):
    """The net-worth surface returned to clients (ADR-122, ADR-123, ADR-180)."""

    total: Decimal = Field(description="The sum of every account's converted balance (assets); a decimal string.")
    currency: Currency = Field(description="The display currency the total is expressed in (ADR-056).")
    accounts: list[AccountBalanceResponse] = Field(description="The per-account breakdown.")
    liabilities: LiabilitiesResponse = Field(
        description="The typed liabilities reservation in the display currency (ADR-180); Slice 1 fills installments.",
    )
    net_after_liabilities: Decimal = Field(
        description="total minus liabilities.total, in the display currency; a derived view, not a redefinition.",
    )

    @classmethod
    def from_read_model(cls, model: NetWorth) -> NetWorthResponse:
        """Build the response from a net-worth read model (ADR-030)."""
        return cls(
            total=model.total,
            currency=model.currency,
            accounts=[AccountBalanceResponse.from_read_model(item) for item in model.accounts],
            liabilities=LiabilitiesResponse.from_read_model(model.liabilities),
            net_after_liabilities=model.net_after_liabilities,
        )
