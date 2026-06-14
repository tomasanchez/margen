"""Boundary schemas for the invoice import contract (ADR-070, ADR-030).

These Pydantic models translate the stateless parse result into the camelCase JSON
the Add/Edit form prefills from (ADR-072): the mapped transaction fields (from the
pure :class:`InvoiceTransactionDraft`), the parse ``status``, the computed fiscal
``naturalKey``, and an advisory ``duplicate`` flag. No persistence happens on this
path; the response is a draft the client holds and confirms (ADR-070). Money is
serialized as ``Decimal`` exactly as the transactions endpoint does (ADR-025).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import Field

from margen_api.entrypoint.schemas import CamelCaseModel
from margen_api.service_layer.invoice_parser import to_transaction_input
from margen_api.service_layer.invoice_parser_read_models import (
    InvoiceNaturalKey,
    ParsedInvoice,
    ParseStatus,
)


class InvoiceNaturalKeyResponse(CamelCaseModel):
    """The fiscal identity computed from a parsed invoice (ADR-068).

    The tuple ``(emisorCuit, ptoVta, tipoCmp, nroCmp)`` uniquely identifies an ARCA
    voucher and backs the advisory dedupe check. Every field is optional because a
    text-only or malformed invoice may not yield each one.
    """

    emisor_cuit: str | None = Field(default=None, description="Issuer (emisor) CUIT.")
    pto_vta: int | None = Field(default=None, description="Point of sale.")
    tipo_cmp: int | None = Field(default=None, description="Voucher/document type code.")
    nro_cmp: int | None = Field(default=None, description="Voucher/document number.")

    @classmethod
    def from_natural_key(cls, key: InvoiceNaturalKey) -> InvoiceNaturalKeyResponse:
        """Build the response from a parsed natural key."""
        return cls(
            emisor_cuit=key.emisor_cuit,
            pto_vta=key.pto_vta,
            tipo_cmp=key.tipo_cmp,
            nro_cmp=key.nro_cmp,
        )


class InvoiceParseResponse(CamelCaseModel):
    """The stateless parse result the Add/Edit form prefills from (ADR-070, ADR-072).

    Carries the mapped transaction fields (aligned with the transaction create
    contract so the UI prefills directly), the parse ``status`` for the calm
    fallback flow (ADR-072), the computed ``naturalKey``, and the advisory
    ``duplicate`` flag (ADR-071). On an unparseable PDF the field set is empty and
    ``status`` is ``unparseable`` — a calm result, not an error.
    """

    status: ParseStatus = Field(description="Parse outcome: ok_qr / ok_text_fallback / unparseable.")
    duplicate: bool = Field(description="Advisory flag: a document with this natural key already exists (ADR-071).")
    natural_key: InvoiceNaturalKeyResponse | None = Field(
        default=None,
        description="The computed fiscal identity, or null when not derivable.",
    )
    occurred_on: date | None = Field(default=None, description="Invoice date (from the QR 'fecha').")
    name: str | None = Field(default=None, description="Client name, or an 'Invoice <ptoVta>-<nroCmp>' fallback.")
    kind: str | None = Field(default=None, description="Always 'invoice' for imported ARCA invoices (ADR-027).")
    amount: Decimal | None = Field(default=None, description="Positive ARS-equivalent total magnitude.")
    currency: str | None = Field(default=None, description="'ARS' or 'USD'.")
    usd_amount: Decimal | None = Field(default=None, description="Original USD figure for USD invoices.")
    fx_rate: Decimal | None = Field(default=None, description="Declared invoice rate (ctz) for USD invoices.")
    fx_rate_type: str | None = Field(default=None, description="'official' for USD invoices (the declared rate).")
    fx_rate_as_of: date | None = Field(default=None, description="The invoice date for USD invoices.")
    category: str | None = Field(default=None, description="A sensible default category, editable at confirm.")
    counts_toward_monotributo: bool | None = Field(
        default=None,
        description="Monotributo counting hint; always true for imported invoices.",
    )

    @classmethod
    def from_parsed(cls, parsed: ParsedInvoice, *, duplicate: bool) -> InvoiceParseResponse:
        """Build the response from a parse result and the dedupe flag (ADR-070).

        Args:
            parsed: The structured parse result from the parser service.
            duplicate: Whether a stored document already matches the natural key.

        Returns:
            The camelCase boundary representation. When the PDF is unparseable the
            mapped fields are left empty so the UI offers a manual fallback
            (ADR-072); otherwise they are populated from the pure mapping.
        """
        natural_key = (
            InvoiceNaturalKeyResponse.from_natural_key(parsed.natural_key) if parsed.natural_key is not None else None
        )
        if parsed.status is ParseStatus.UNPARSEABLE:
            return cls(status=parsed.status, duplicate=duplicate, natural_key=natural_key)

        draft = to_transaction_input(parsed)
        return cls(
            status=parsed.status,
            duplicate=duplicate,
            natural_key=natural_key,
            occurred_on=draft.occurred_on,
            name=draft.name,
            kind=draft.kind,
            amount=draft.amount,
            currency=draft.currency,
            usd_amount=draft.usd_amount,
            fx_rate=draft.fx_rate,
            fx_rate_type=draft.fx_rate_type,
            fx_rate_as_of=draft.fx_rate_as_of,
            category=draft.category,
            counts_toward_monotributo=draft.counts_toward_monotributo,
        )
