"""Boundary schemas for the transaction REST contract (ADR-030, ADR-024).

These Pydantic models translate the persisted aggregate / read model to and from
the JSON shape the frontend prototype already speaks (``apps/web/src/mock/types.ts``).
The JSON uses **camelCase aliases matching the mock field names** so the frontend
can swap its mock for this API with minimal churn in #14 (ADR-024). The bridge
between the mock names and the backend-native names is:

- ``amountNum`` -> ``amount`` (the positive ARS-equivalent magnitude)
- ``usd``       -> ``usd_amount``
- ``rate``      -> ``fx_rate``
- ``bank``      -> ``payment_method``
- ``name``      -> ``name`` (the required display label is a first-class field on
  the durable model — ADR-024 KEEP)
- ``notes``     -> ``notes`` (the optional free-text note #3 adds, distinct from
  ``name`` — ADR-024 ADD)

``type``, ``month`` and ``dispDate`` are **derived** from the persisted ``kind`` /
``occurred_on`` here (ADR-026, ADR-027) — never stored — so the UI's display
helpers keep working without a client-side derivation step.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.transaction import CreateTransaction, UpdateTransaction
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.read_models import TransactionReadModel


def _disp_date(value: date) -> str:
    """Render a short display date such as ``"Jun 12"`` (mock ``dispDate``)."""
    return f"{value.strftime('%b')} {value.day}"


def _month_name(value: date) -> str:
    """Render the full month name such as ``"June"`` (mock ``month``)."""
    return value.strftime("%B")


class TransactionResponse(CamelCaseModel):
    """The transaction shape returned to clients (ADR-030).

    Mirrors the prototype ``Transaction`` interface, exposing the persisted
    fields under the mock's camelCase names plus the derived ``type``, ``month``
    and ``dispDate`` display helpers so the UI adopts the contract with minimal
    churn (ADR-024, ADR-026, ADR-027).
    """

    id: UUID = Field(description="Stable UUID identity, safe to expose in URLs.")
    occurred_on: date = Field(description="Real calendar date the movement happened (ISO 8601).")
    disp_date: str = Field(description="Derived short display date, e.g. 'Jun 12'. Not stored (ADR-026).")
    month: str = Field(description="Derived full month name, e.g. 'June'. Not stored (ADR-026).")
    name: str = Field(description="Required human display label for the movement (ADR-024).")
    notes: str | None = Field(
        default=None,
        description="Optional free-text note, distinct from 'name' (ADR-024).",
    )
    category: str | None = Field(default=None, description="Category label; tolerant of unknown values (ADR-027).")
    payment_method: str | None = Field(
        default=None,
        serialization_alias="bank",
        description="Bank / card / channel label. Aliased to the mock's 'bank'.",
    )
    currency: Currency = Field(description="ARS (base) or USD.")
    type: TxType = Field(description="High-level direction derived from 'kind' (ADR-027).")
    kind: Kind = Field(description="Persisted money kind: expense / income / invoice.")
    amount: Decimal = Field(
        serialization_alias="amountNum",
        description="Positive ARS-equivalent magnitude. Aliased to the mock's 'amountNum'.",
    )
    usd_amount: Decimal | None = Field(
        default=None,
        serialization_alias="usd",
        description="Original USD amount for USD rows. Aliased to the mock's 'usd'.",
    )
    fx_rate: Decimal | None = Field(
        default=None,
        serialization_alias="rate",
        description="Conversion rate used for USD rows. Aliased to the mock's 'rate'.",
    )
    fx_rate_type: FxRateType | None = Field(default=None, description="FX rate family (defaults to MEP for USD rows).")
    fx_rate_as_of: datetime | None = Field(default=None, description="Timestamp the FX rate was observed.")
    recurring: bool = Field(description="Whether the movement repeats.")
    counts_toward_monotributo: bool = Field(description="Monotributo counting hint (income / invoice only).")
    created_at: datetime = Field(description="Server-managed creation timestamp.")
    updated_at: datetime = Field(description="Server-managed last-update timestamp.")

    @classmethod
    def from_read_model(cls, model: TransactionReadModel) -> TransactionResponse:
        """Build the response from a query-side read model (ADR-014, ADR-030).

        Args:
            model: The transaction read model from the reader port.

        Returns:
            The camelCase boundary representation, with ``type``/``month``/
            ``dispDate`` derived from the persisted fields.
        """
        return cls(
            id=model.id,
            occurred_on=model.occurred_on,
            disp_date=_disp_date(model.occurred_on),
            month=_month_name(model.occurred_on),
            name=model.name,
            notes=model.notes,
            category=model.category,
            payment_method=model.payment_method,
            currency=model.currency,
            type=model.type,
            kind=model.kind,
            amount=model.amount,
            usd_amount=model.usd_amount,
            fx_rate=model.fx_rate,
            fx_rate_type=model.fx_rate_type,
            fx_rate_as_of=model.fx_rate_as_of,
            recurring=model.recurring,
            counts_toward_monotributo=model.counts_toward_monotributo,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )


class TransactionCreateRequest(CamelCaseModel):
    """Request body for ``POST /transactions`` (maps to :class:`CreateTransaction`).

    Accepts the mock's camelCase field names. Lenient validation (ADR-031):
    only true invariant violations are rejected here (non-positive ``amountNum``,
    unknown ``kind`` / ``currency``); USD without a rate is accepted as incomplete.
    """

    occurred_on: date = Field(description="Real calendar date of the movement (ISO 8601). Backdating allowed.")
    kind: Kind = Field(description="Money kind: expense / income / invoice.")
    amount: Annotated[Decimal, Field(gt=Decimal(0))] = Field(
        validation_alias="amountNum",
        serialization_alias="amountNum",
        description="Positive ARS-equivalent magnitude. Aliased to the mock's 'amountNum'.",
    )
    currency: Currency = Field(default=Currency.ARS, description="ARS (base) or USD.")
    usd_amount: Decimal | None = Field(
        default=None,
        validation_alias="usd",
        serialization_alias="usd",
        description="Original USD amount for USD rows. Aliased to 'usd'.",
    )
    fx_rate: Decimal | None = Field(
        default=None,
        validation_alias="rate",
        serialization_alias="rate",
        description="Conversion rate for USD rows. Aliased to 'rate'. Optional (ADR-031).",
    )
    fx_rate_type: FxRateType | None = Field(default=None, description="FX rate family; defaults to MEP for USD rows.")
    fx_rate_as_of: datetime | None = Field(default=None, description="Timestamp the FX rate was observed.")
    name: str = Field(
        min_length=1,
        validation_alias="name",
        serialization_alias="name",
        description="Required human display label for the movement (ADR-024).",
    )
    notes: str | None = Field(
        default=None,
        validation_alias="notes",
        serialization_alias="notes",
        description="Optional free-text note, distinct from 'name' (ADR-024).",
    )
    category: str | None = Field(default=None, description="Category label; optional (ADR-031).")
    payment_method: str | None = Field(
        default=None,
        validation_alias="bank",
        serialization_alias="bank",
        description="Bank / card / channel label. Aliased to 'bank'.",
    )
    recurring: bool = Field(default=False, description="Whether the movement repeats.")
    counts_toward_monotributo: bool = Field(
        default=False,
        description="Monotributo counting hint; forced False for expense (ADR-031).",
    )

    def to_command(self) -> CreateTransaction:
        """Translate the request into a :class:`CreateTransaction` command.

        Returns:
            The boundary-agnostic command the message bus dispatches.
        """
        return CreateTransaction(
            occurred_on=self.occurred_on,
            name=self.name,
            kind=self.kind,
            amount=self.amount,
            currency=self.currency,
            usd_amount=self.usd_amount,
            fx_rate=self.fx_rate,
            fx_rate_type=self.fx_rate_type,
            fx_rate_as_of=self.fx_rate_as_of,
            category=self.category,
            payment_method=self.payment_method,
            notes=self.notes,
            recurring=self.recurring,
            counts_toward_monotributo=self.counts_toward_monotributo,
        )


class TransactionPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /transactions/{id}`` (maps to :class:`UpdateTransaction`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028). Accepts the mock's camelCase field names.
    """

    occurred_on: date | None = Field(default=None, description="New movement date (ISO 8601).")
    kind: Kind | None = Field(default=None, description="New money kind.")
    amount: Annotated[Decimal | None, Field(gt=Decimal(0))] = Field(
        default=None,
        validation_alias="amountNum",
        serialization_alias="amountNum",
        description="New positive ARS-equivalent magnitude. Aliased to 'amountNum'.",
    )
    currency: Currency | None = Field(default=None, description="New currency.")
    usd_amount: Decimal | None = Field(
        default=None,
        validation_alias="usd",
        serialization_alias="usd",
        description="New USD amount. Aliased to 'usd'.",
    )
    fx_rate: Decimal | None = Field(
        default=None,
        validation_alias="rate",
        serialization_alias="rate",
        description="New FX rate. Aliased to 'rate'.",
    )
    fx_rate_type: FxRateType | None = Field(default=None, description="New FX rate family.")
    fx_rate_as_of: datetime | None = Field(default=None, description="New FX observation timestamp.")
    name: str | None = Field(
        default=None,
        min_length=1,
        validation_alias="name",
        serialization_alias="name",
        description="New human display label; omitted leaves it unchanged (ADR-024).",
    )
    notes: str | None = Field(
        default=None,
        validation_alias="notes",
        serialization_alias="notes",
        description="New free-text note, distinct from 'name' (ADR-024).",
    )
    category: str | None = Field(default=None, description="New category label.")
    payment_method: str | None = Field(
        default=None,
        validation_alias="bank",
        serialization_alias="bank",
        description="New bank / card / channel label. Aliased to 'bank'.",
    )
    recurring: bool | None = Field(default=None, description="New recurring flag.")
    counts_toward_monotributo: bool | None = Field(default=None, description="New Monotributo counting hint.")

    def to_command(self, transaction_id: UUID) -> UpdateTransaction:
        """Translate the patch into an :class:`UpdateTransaction` command.

        Args:
            transaction_id: The identity from the URL path.

        Returns:
            The command addressing one aggregate; ``None`` fields are left
            unchanged by the handler.
        """
        return UpdateTransaction(
            id=transaction_id,
            occurred_on=self.occurred_on,
            name=self.name,
            kind=self.kind,
            amount=self.amount,
            currency=self.currency,
            usd_amount=self.usd_amount,
            fx_rate=self.fx_rate,
            fx_rate_type=self.fx_rate_type,
            fx_rate_as_of=self.fx_rate_as_of,
            category=self.category,
            payment_method=self.payment_method,
            notes=self.notes,
            recurring=self.recurring,
            counts_toward_monotributo=self.counts_toward_monotributo,
        )
