"""Read models for the ARCA invoice parser (ADR-069, ADR-068).

Purpose-built, immutable DTOs describing the result of parsing an ARCA invoice
PDF: the decoded AFIP QR fields (:class:`ArcaQrData`), the natural identity of the
fiscal document (:class:`InvoiceNaturalKey`), the overall parse outcome
(:class:`ParsedInvoice` with a :class:`ParseStatus`), and the pure mapping draft
fed to the transaction create path (:class:`InvoiceTransactionDraft`).

These stay deliberately separate from the transaction write aggregate so the
import side evolves independently (AGENTS.md: reader ports + read models). Money is
carried as :class:`~decimal.Decimal` (ADR-025); the AFIP QR JSON keys are mapped to
``snake_case`` attributes here at the boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum


class ParseStatus(StrEnum):
    """Outcome of parsing an ARCA invoice PDF (ADR-069).

    Attributes:
        OK_QR: The embedded AFIP QR was found and decoded into structured fields.
        OK_TEXT_FALLBACK: No usable QR, but PDF text was extracted for the user to
            review and complete at the confirm step (ADR-068).
        UNPARSEABLE: Neither a QR nor extractable text was obtained.
    """

    OK_QR = "ok_qr"
    OK_TEXT_FALLBACK = "ok_text_fallback"
    UNPARSEABLE = "unparseable"


@dataclass(frozen=True, slots=True)
class ArcaQrData:
    """Structured fields decoded from the AFIP QR JSON payload (ADR-068, ADR-069).

    The AFIP QR encodes a URL ``https://www.afip.gob.ar/fe/qr/?p=<base64url(JSON)>``
    whose JSON carries the fiscal fields below. JSON keys are ``camelCase`` and are
    mapped to ``snake_case`` attributes; money (``importe``/``ctz``) is coerced to
    :class:`~decimal.Decimal` (ADR-025) and ``fecha`` to a :class:`~datetime.date`.

    Attributes:
        ver: QR format version (JSON ``ver``).
        fecha: Invoice date, parsed from ``YYYY-MM-DD`` (JSON ``fecha``).
        cuit: Issuer (emisor) CUIT (JSON ``cuit``).
        pto_vta: Point of sale (JSON ``ptoVta``).
        tipo_cmp: Voucher/document type code (JSON ``tipoCmp``).
        nro_cmp: Voucher/document number (JSON ``nroCmp``).
        importe: Invoice total in the document currency (JSON ``importe``).
        moneda: Currency code such as ``"PES"`` (ARS) or ``"DOL"`` (USD)
            (JSON ``moneda``).
        ctz: Quotation / exchange rate to ARS (JSON ``ctz``).
        tipo_cod_aut: Authorization code type, e.g. ``"E"`` for CAE
            (JSON ``tipoCodAut``).
        cod_aut: Authorization code (CAE) (JSON ``codAut``).
        nro_doc_rec: Receptor document number (JSON ``nroDocRec``).
    """

    ver: int | None
    fecha: date | None
    cuit: str | None
    pto_vta: int | None
    tipo_cmp: int | None
    nro_cmp: int | None
    importe: Decimal | None
    moneda: str | None
    ctz: Decimal | None
    tipo_cod_aut: str | None
    cod_aut: str | None
    nro_doc_rec: str | None


@dataclass(frozen=True, slots=True)
class InvoiceNaturalKey:
    """The natural identity of a fiscal document (ADR-068).

    The tuple ``(emisor_cuit, pto_vta, tipo_cmp, nro_cmp)`` uniquely identifies an
    ARCA voucher and is the basis for deduplication at the import step.

    Attributes:
        emisor_cuit: Issuer (emisor) CUIT.
        pto_vta: Point of sale.
        tipo_cmp: Voucher/document type code.
        nro_cmp: Voucher/document number.
    """

    emisor_cuit: str | None
    pto_vta: int | None
    tipo_cmp: int | None
    nro_cmp: int | None


@dataclass(frozen=True, slots=True)
class ParsedInvoice:
    """The structured result of parsing one ARCA invoice PDF (ADR-069).

    Attributes:
        status: The parse outcome (:class:`ParseStatus`).
        qr: The decoded AFIP QR fields, or ``None`` when no QR was decoded.
        extracted_text: The concatenated PDF text (best effort; may be empty).
        client_name: The receptor/client name pulled from PDF text, or ``None``.
        natural_key: The fiscal document identity when derivable, or ``None``.
    """

    status: ParseStatus
    qr: ArcaQrData | None
    extracted_text: str
    client_name: str | None
    natural_key: InvoiceNaturalKey | None


@dataclass(frozen=True, slots=True)
class InvoiceTransactionDraft:
    """A pure mapping of parsed QR fields to transaction create-input values.

    Mirrors the :class:`~margen_api.domain.commands.transaction.CreateTransaction`
    contract (ADR-068 field mapping) so the next task can feed these values straight
    into the create path. ``amount`` is the positive ARS-equivalent magnitude
    (ADR-025); the FX block follows ADR-044/045 for non-ARS invoices.

    Attributes:
        occurred_on: Invoice date (from ``fecha``).
        name: Client name, or ``"Invoice <ptoVta>-<nroCmp>"`` fallback.
        kind: Always ``"invoice"`` for imported ARCA invoices (ADR-027).
        amount: Positive ARS-equivalent total.
        currency: ``"ARS"`` or ``"USD"``.
        usd_amount: Original USD figure for USD invoices, else ``None``.
        fx_rate: The invoice's declared rate (``ctz``) for USD invoices, else
            ``None``.
        fx_rate_type: ``"official"`` for USD invoices (the declared rate), else
            ``None``.
        fx_rate_as_of: The invoice date for USD invoices, else ``None``.
        category: A sensible income/services default, editable at confirm.
        counts_toward_monotributo: Always ``True`` for imported invoices
            (ADR-027/031).
    """

    occurred_on: date | None
    name: str
    kind: str
    amount: Decimal | None
    currency: str
    usd_amount: Decimal | None
    fx_rate: Decimal | None
    fx_rate_type: str | None
    fx_rate_as_of: date | None
    category: str
    counts_toward_monotributo: bool
