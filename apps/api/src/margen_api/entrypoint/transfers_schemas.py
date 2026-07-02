"""Boundary schemas for the transfers REST contract (ADR-135, ADR-130).

These Pydantic models translate the transfer read model and the create body to and
from the camelCase JSON the frontend builds to (the pinned contract). Money crosses
the boundary as a decimal string exactly as the rest of the app serializes
``Decimal`` (ADR-025, ADR-030). A transfer moves money between two of the caller's
accounts (ADR-135); optional ``fees`` ride on the create so each is recorded as an
expense transaction in the same unit of work.

Pinned JSON contract:

* Transfer = ``{ id, fromAccountId, toAccountId, amountOut: string, amountIn: string,
  occurredOn: 'YYYY-MM-DD', note?: string }``
* ``POST /transfers`` body = ``{ fromAccountId, toAccountId, amountOut, amountIn,
  occurredOn, note?, fees?: [{ accountId, amount, label }] }`` and returns the
  created transfer plus the created fee transaction ids.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.transfer import CreateTransfer, TransferFeeInput
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.transfer_read_models import TransferReadModel


class TransferResponse(CamelCaseModel):
    """The transfer shape returned to clients (ADR-135)."""

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    from_account_id: UUID = Field(description="The source account's UUID; money was debited from it.")
    to_account_id: UUID = Field(description="The destination account's UUID; money was credited to it.")
    amount_out: Decimal = Field(description="The source-native magnitude debited; a decimal string (ADR-025).")
    amount_in: Decimal = Field(description="The destination-native magnitude credited; a decimal string (ADR-025).")
    occurred_on: date = Field(description="The calendar date the transfer happened (YYYY-MM-DD).")
    note: str | None = Field(default=None, description="An optional free-form note.")

    @classmethod
    def from_read_model(cls, model: TransferReadModel) -> TransferResponse:
        """Build the response from a query-side read model (ADR-030)."""
        return cls(
            id=model.id,
            from_account_id=model.from_account_id,
            to_account_id=model.to_account_id,
            amount_out=model.amount_out,
            amount_in=model.amount_in,
            occurred_on=model.occurred_on,
            note=model.note,
        )


class TransferFeeRequest(CamelCaseModel):
    """One fee on a transfer, recorded as an expense transaction (ADR-135).

    The fee becomes a ``kind=expense`` transaction in the "Fees" category on
    ``accountId`` in that account's native currency. The fee account must belong to
    the caller (ADR-130). The client may stamp an FX snapshot (``rate`` + ``fxSource``)
    exactly as it does on a manual expense (ADR-148, ADR-149) so the fee's
    ``usd_amount`` materializes; both are optional and a fee without them stays
    null-snapshot (ADR-031).
    """

    account_id: UUID = Field(description="The account the fee is charged to; must belong to the caller.")
    amount: Decimal = Field(gt=Decimal(0), description="The positive fee magnitude in the account's native currency.")
    label: str = Field(min_length=1, description="The fee expense's display name (e.g. 'Deel fee').")
    fx_rate: Decimal | None = Field(
        default=None,
        validation_alias="rate",
        serialization_alias="rate",
        description="The ARS-per-1-USD rate the client captured for the fee. Aliased to 'rate'; optional (ADR-149).",
    )
    fx_source: str | None = Field(
        default=None,
        description="Provenance of the fee's FX snapshot rate (e.g. 'bolsa'); optional (ADR-148, ADR-149).",
    )

    def to_input(self) -> TransferFeeInput:
        """Translate the request fee into the command's :class:`TransferFeeInput`."""
        return TransferFeeInput(
            account_id=self.account_id,
            amount=self.amount,
            label=self.label,
            fx_rate=self.fx_rate,
            fx_source=self.fx_source,
        )


class TransferCreateRequest(CamelCaseModel):
    """Request body for ``POST /transfers`` (maps to :class:`CreateTransfer`).

    A transfer moves money between two of the caller's accounts (ADR-135).
    ``amountOut`` is debited from ``fromAccountId`` (source-native), ``amountIn`` is
    credited to ``toAccountId`` (destination-native); pass them equal for a
    same-currency transfer. ``fees`` is optional; each fee is recorded as an expense
    transaction atomically with the transfer (ADR-135).
    """

    from_account_id: UUID = Field(description="The source account's UUID.")
    to_account_id: UUID = Field(description="The destination account's UUID.")
    amount_out: Decimal = Field(gt=Decimal(0), description="The source-native magnitude debited (ADR-025).")
    amount_in: Decimal = Field(gt=Decimal(0), description="The destination-native magnitude credited (ADR-025).")
    occurred_on: date = Field(description="The calendar date the transfer happened.")
    note: str | None = Field(default=None, description="An optional free-form note.")
    fees: list[TransferFeeRequest] = Field(default_factory=list, description="Optional fees recorded as expenses.")

    def to_command(self, user_id: str) -> CreateTransfer:
        """Translate the request into a :class:`CreateTransfer` command.

        Args:
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint stamps
                onto the command so the created transfer and its fee expenses are
                owned (ADR-130).

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return CreateTransfer(
            user_id=user_id,
            from_account_id=self.from_account_id,
            to_account_id=self.to_account_id,
            amount_out=self.amount_out,
            amount_in=self.amount_in,
            occurred_on=self.occurred_on,
            note=self.note,
            fees=tuple(fee.to_input() for fee in self.fees),
        )


class TransferCreatedResponse(CamelCaseModel):
    """The created transfer plus the ids of the fee expenses it created (ADR-135).

    Extends the bare transfer shape with ``feeTransactionIds`` so the client can link
    the created fee expenses without re-reading the transactions list.
    """

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    from_account_id: UUID = Field(description="The source account's UUID; money was debited from it.")
    to_account_id: UUID = Field(description="The destination account's UUID; money was credited to it.")
    amount_out: Decimal = Field(description="The source-native magnitude debited; a decimal string (ADR-025).")
    amount_in: Decimal = Field(description="The destination-native magnitude credited; a decimal string (ADR-025).")
    occurred_on: date = Field(description="The calendar date the transfer happened (YYYY-MM-DD).")
    note: str | None = Field(default=None, description="An optional free-form note.")
    fee_transaction_ids: list[UUID] = Field(
        default_factory=list,
        description="Ids of the fee expense transactions created with the transfer, in fee order.",
    )
