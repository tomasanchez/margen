"""Boundary schemas for the transaction REST contract (ADR-030, ADR-024).

These Pydantic models translate the persisted aggregate / read model to and from
the JSON shape the frontend prototype already speaks (``apps/web/src/mock/types.ts``).
The JSON uses **camelCase aliases matching the mock field names** so the frontend
can swap its mock for this API with minimal churn in #14 (ADR-024). The bridge
between the mock names and the backend-native names is:

- ``amountNum`` -> ``amount`` (the positive ARS-equivalent magnitude)
- ``usd``       -> ``usd_amount``
- ``rate``      -> ``fx_rate``
- ``bank``      -> ``payment_method`` (the normalized bank — ADR-117)
- ``card``      -> ``card`` (the card / detail label for display — ADR-117)
- ``name``      -> ``name`` (the required display label is a first-class field on
  the durable model — ADR-024 KEEP)
- ``notes``     -> ``notes`` (the optional free-text note #3 adds, distinct from
  ``name`` — ADR-024 ADD)

``type``, ``month`` and ``dispDate`` are **derived** from the persisted ``kind`` /
``occurred_on`` here (ADR-026, ADR-027) — never stored — so the UI's display
helpers keep working without a client-side derivation step.
"""

from __future__ import annotations

import base64
import binascii
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import Field

from margen_api.domain.commands.transaction import (
    CreateTransaction,
    SetTransactionFxSnapshot,
    TransactionDocumentPayload,
    UpdateTransaction,
)
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, RecurringCadence, TxType
from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.read_models import TransactionReadModel


class InvalidDocumentBase64Error(ValueError):
    """Raised when an attachment's ``pdfBase64`` is not valid base64 (ADR-070)."""

    def __init__(self) -> None:
        super().__init__("pdfBase64 is not valid base64.")


class TransactionDocumentRequest(CamelCaseModel):
    """Optional invoice attachment on ``POST /transactions`` (ADR-070, ADR-071).

    The PDF crosses the JSON boundary as base64 (``pdfBase64``); everything else
    is the import metadata produced by the parse endpoint that the client echoes
    back on confirm. Decoding to raw bytes happens in :meth:`to_payload` so the
    bytes never enter the transaction aggregate (they become a side record).
    Money is ``Decimal`` (ADR-025).
    """

    pdf_base64: str = Field(description="The original PDF, base64-encoded for the JSON body.")
    content_type: str = Field(default="application/pdf", description="MIME type of the upload.")
    extracted_text: str | None = Field(default=None, description="Parsed PDF text, echoed from parse.")
    qr_json: dict | None = Field(default=None, description="Decoded AFIP QR JSON payload, echoed from parse.")
    emisor_cuit: str | None = Field(default=None, description="Issuer CUIT from the natural key.")
    pto_vta: str | None = Field(default=None, description="Point of sale from the natural key.")
    tipo_cmp: str | None = Field(default=None, description="Voucher type code from the natural key.")
    nro_cmp: str | None = Field(default=None, description="Voucher number from the natural key.")
    cae: str | None = Field(default=None, description="Electronic authorization code, if parsed.")
    fecha: date | None = Field(default=None, description="Invoice date, if parsed.")
    importe: Decimal | None = Field(default=None, description="Invoice total in its original currency, if parsed.")
    moneda: str | None = Field(default=None, description="Currency code (e.g. ARS), if parsed.")
    ctz: Decimal | None = Field(default=None, description="Exchange rate declared on the invoice, if parsed.")

    def to_payload(self) -> TransactionDocumentPayload:
        """Decode the base64 PDF and build the command's document payload.

        Returns:
            The :class:`TransactionDocumentPayload` carrying raw PDF bytes (kept
            out of the aggregate) and the import metadata.

        Raises:
            InvalidDocumentBase64Error: When ``pdfBase64`` is not valid base64.
        """
        try:
            pdf_bytes = base64.b64decode(self.pdf_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise InvalidDocumentBase64Error from error
        return TransactionDocumentPayload(
            pdf_bytes=pdf_bytes,
            content_type=self.content_type,
            byte_size=len(pdf_bytes),
            extracted_text=self.extracted_text,
            qr_json=self.qr_json,
            emisor_cuit=self.emisor_cuit,
            pto_vta=self.pto_vta,
            tipo_cmp=self.tipo_cmp,
            nro_cmp=self.nro_cmp,
            cae=self.cae,
            fecha=self.fecha,
            importe=self.importe,
            moneda=self.moneda,
            ctz=self.ctz,
        )


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
        description="Normalized bank / channel label. Aliased to the JSON 'bank' (ADR-117).",
    )
    card: str | None = Field(
        default=None,
        description="Card / detail label for display, e.g. 'VISA ·5771'; null when none (ADR-117).",
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
    fx_source: str | None = Field(
        default=None,
        description="Provenance of the FX snapshot rate (e.g. 'bolsa'); null when no snapshot (ADR-148).",
    )
    fx_rate_type: FxRateType | None = Field(default=None, description="FX rate family (defaults to MEP for USD rows).")
    fx_rate_as_of: datetime | None = Field(default=None, description="Timestamp the FX rate was observed.")
    recurring: bool = Field(description="Whether the movement repeats.")
    recurring_cadence: RecurringCadence | None = Field(
        default=None,
        description="How often a committed outflow repeats: monthly / quarterly / annual / installment (ADR-174).",
    )
    installments_total: int | None = Field(
        default=None,
        description="For an installment cadence, the plan's total payments (the M of a cuota N/M); null otherwise.",
    )
    installments_index: int | None = Field(
        default=None,
        description="For an installment cadence, this payment's 1-based position (the N of a cuota N/M); null otherwise.",
    )
    counts_toward_monotributo: bool = Field(description="Monotributo counting hint (income / invoice only).")
    account_id: UUID | None = Field(
        default=None,
        description="The owning account's id, or null when unattributed (ADR-122).",
    )
    offsets_transaction_id: UUID | None = Field(
        default=None,
        description=(
            "For a reimbursement, the linked expense id this payback offsets; null "
            "for every other kind. Serialized as 'offsetsTransactionId' (ADR-158/159)."
        ),
    )
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
            card=model.card,
            currency=model.currency,
            type=model.type,
            kind=model.kind,
            amount=model.amount,
            usd_amount=model.usd_amount,
            fx_rate=model.fx_rate,
            fx_source=model.fx_source,
            fx_rate_type=model.fx_rate_type,
            fx_rate_as_of=model.fx_rate_as_of,
            recurring=model.recurring,
            recurring_cadence=model.recurring_cadence,
            installments_total=model.installments_total,
            installments_index=model.installments_index,
            counts_toward_monotributo=model.counts_toward_monotributo,
            account_id=model.account_id,
            offsets_transaction_id=model.offsets_transaction_id,
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
    fx_source: str | None = Field(
        default=None,
        description="Provenance of the FX snapshot rate (e.g. 'bolsa'); optional (ADR-148, ADR-149).",
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
        description="Normalized bank / channel label. Aliased to 'bank' (ADR-117).",
    )
    card: str | None = Field(
        default=None,
        description="Card / detail label for display, e.g. 'VISA ·5771'; null when none (ADR-117).",
    )
    recurring: bool = Field(default=False, description="Whether the movement repeats.")
    recurring_cadence: RecurringCadence | None = Field(
        default=None,
        description="How often a committed outflow repeats: monthly / quarterly / annual / installment (ADR-174).",
    )
    installments_total: int | None = Field(
        default=None,
        description="For an installment cadence, the plan's total payments (the M of a cuota N/M); optional.",
    )
    installments_index: int | None = Field(
        default=None,
        description="For an installment cadence, this payment's 1-based position (the N of a cuota N/M); optional.",
    )
    counts_toward_monotributo: bool = Field(
        default=False,
        description="Monotributo counting hint; forced False for expense (ADR-031).",
    )
    account_id: UUID | None = Field(
        default=None,
        description="The owning account's id; must be one of the caller's accounts (ADR-122, ADR-130).",
    )
    offsets_transaction_id: UUID | None = Field(
        default=None,
        description=(
            "For a reimbursement, the id of the EXPENSE this payback offsets (ADR-159). "
            "Must be one of the caller's own expenses; ignored for every other kind. "
            "Accepted as 'offsetsTransactionId'."
        ),
    )
    document: TransactionDocumentRequest | None = Field(
        default=None,
        description="Optional imported invoice PDF to store and link (ADR-070, ADR-071).",
    )

    def to_command(self, user_id: str) -> CreateTransaction:
        """Translate the request into a :class:`CreateTransaction` command.

        Args:
            user_id: The authenticated owner (``AuthUser.id``) the entrypoint
                stamps onto the command so the created row is owned (ADR-108).

        Returns:
            The boundary-agnostic command the message bus dispatches; the optional
            ``document`` is decoded to a side-record payload (raw bytes stay out of
            the aggregate) when supplied.

        Raises:
            InvalidDocumentBase64Error: When a document's ``pdfBase64`` is invalid.
        """
        return CreateTransaction(
            user_id=user_id,
            occurred_on=self.occurred_on,
            name=self.name,
            kind=self.kind,
            amount=self.amount,
            currency=self.currency,
            usd_amount=self.usd_amount,
            fx_rate=self.fx_rate,
            fx_source=self.fx_source,
            fx_rate_type=self.fx_rate_type,
            fx_rate_as_of=self.fx_rate_as_of,
            category=self.category,
            payment_method=self.payment_method,
            card=self.card,
            notes=self.notes,
            recurring=self.recurring,
            recurring_cadence=self.recurring_cadence,
            installments_total=self.installments_total,
            installments_index=self.installments_index,
            counts_toward_monotributo=self.counts_toward_monotributo,
            account_id=self.account_id,
            offsets_transaction_id=self.offsets_transaction_id,
            document=self.document.to_payload() if self.document is not None else None,
        )


class TransactionPatchRequest(CamelCaseModel):
    """Request body for ``PATCH /transactions/{id}`` (maps to :class:`UpdateTransaction`).

    Every field is optional; an omitted field leaves the stored value unchanged
    (ADR-028). Accepts the mock's camelCase field names. ``card`` is intentionally
    NOT patchable: the edit form never sends it, and the handler preserves the
    existing card so an edit never wipes the imported detail (ADR-117).
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
    fx_source: str | None = Field(default=None, description="New FX snapshot rate provenance (ADR-148).")
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
        description="New normalized bank / channel label. Aliased to 'bank' (ADR-117).",
    )
    recurring: bool | None = Field(default=None, description="New recurring flag.")
    recurring_cadence: RecurringCadence | None = Field(
        default=None,
        description="New recurring cadence: monthly / quarterly / annual / installment; null leaves it unchanged.",
    )
    installments_total: int | None = Field(default=None, description="New instalment plan total; null unchanged.")
    installments_index: int | None = Field(default=None, description="New instalment 1-based position; null unchanged.")
    counts_toward_monotributo: bool | None = Field(default=None, description="New Monotributo counting hint.")
    account_id: UUID | None = Field(
        default=None,
        description="New owning account id; must be one of the caller's accounts (ADR-122, ADR-130).",
    )

    def to_command(self, transaction_id: UUID, user_id: str) -> UpdateTransaction:
        """Translate the patch into an :class:`UpdateTransaction` command.

        Args:
            transaction_id: The identity from the URL path.
            user_id: The authenticated owner (``AuthUser.id``) the handler scopes
                the load/persist by, so a cross-tenant patch is a 404 (ADR-108,
                ADR-111).

        Returns:
            The command addressing one aggregate; ``None`` fields are left
            unchanged by the handler.
        """
        return UpdateTransaction(
            id=transaction_id,
            user_id=user_id,
            occurred_on=self.occurred_on,
            name=self.name,
            kind=self.kind,
            amount=self.amount,
            currency=self.currency,
            usd_amount=self.usd_amount,
            fx_rate=self.fx_rate,
            fx_source=self.fx_source,
            fx_rate_type=self.fx_rate_type,
            fx_rate_as_of=self.fx_rate_as_of,
            category=self.category,
            payment_method=self.payment_method,
            notes=self.notes,
            recurring=self.recurring,
            recurring_cadence=self.recurring_cadence,
            installments_total=self.installments_total,
            installments_index=self.installments_index,
            counts_toward_monotributo=self.counts_toward_monotributo,
            account_id=self.account_id,
        )


class TransactionFxSnapshotRequest(CamelCaseModel):
    """Request body for ``PUT /transactions/{id}/fx`` (maps to :class:`SetTransactionFxSnapshot`).

    Sets or replaces the FX snapshot on an existing transaction (ADR-148, ADR-149).
    The client supplies the ARS-per-1-USD ``fxRate`` and its ``fxSource`` provenance;
    the handler re-materializes ``usd_amount`` as pure arithmetic (no FX feed, ADR-149).
    Powers the client import rate-fill step and the one-time historical backfill
    (ADR-149/150).
    """

    fx_rate: Decimal = Field(
        gt=Decimal(0),
        description="The ARS-per-1-USD rate the client captured; must be positive (ADR-149).",
    )
    fx_source: str | None = Field(
        default=None,
        description="Provenance of the rate, e.g. 'bolsa' / 'mep' / 'oficial' / 'manual' / 'backfill' (ADR-148).",
    )

    def to_command(self, transaction_id: UUID, user_id: str) -> SetTransactionFxSnapshot:
        """Translate the request into a :class:`SetTransactionFxSnapshot` command.

        Args:
            transaction_id: The identity from the URL path.
            user_id: The authenticated owner (``AuthUser.id``) the handler scopes the
                load/persist by, so a cross-tenant snapshot is a 404 (ADR-108, ADR-111).

        Returns:
            The command addressing one aggregate by identity.
        """
        return SetTransactionFxSnapshot(
            id=transaction_id,
            user_id=user_id,
            fx_rate=self.fx_rate,
            fx_source=self.fx_source,
        )
