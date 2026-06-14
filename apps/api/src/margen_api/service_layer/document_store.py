"""Storage port for the stored invoice document (ADR-071).

A small storage abstraction over the original PDF and its import metadata. The
only adapter today is Postgres (``BYTEA`` in the ``invoice_document`` table); a
future Azure Blob adapter becomes a drop-in by storing a blob reference instead
of bytes without touching callers (ADR-071, ADR-073). Writes happen on the unit
of work alongside the transaction repository (ADR-070). Money is carried as
:class:`~decimal.Decimal` (ADR-025). Concrete adapters live under
``margen_api.adapters``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True, slots=True)
class InvoiceDocument:
    """Read model for downloading a stored invoice document (ADR-071).

    Carries the original bytes plus the metadata a download needs, kept separate
    from the write aggregate so the query side evolves independently.

    Attributes:
        transaction_id: The transaction this document belongs to (1:1).
        pdf_bytes: The original uploaded PDF bytes.
        content_type: The stored MIME type (e.g. ``application/pdf``).
        byte_size: The PDF size in bytes.
        extracted_text: Parsed text, or ``None`` when no text was extracted.
        qr_json: Decoded QR payload, or ``None`` when absent.
        emisor_cuit: Issuer CUIT from the invoice natural key, if parsed.
        pto_vta: Point of sale from the natural key, if parsed.
        tipo_cmp: Voucher type code from the natural key, if parsed.
        nro_cmp: Voucher number from the natural key, if parsed.
        cae: Electronic authorization code, if parsed.
        fecha: Invoice date, if parsed.
        importe: Invoice total in its original currency, if parsed.
        moneda: Currency code (e.g. ``ARS``), if parsed.
        ctz: Exchange rate used on the invoice, if parsed.
    """

    transaction_id: UUID
    pdf_bytes: bytes
    content_type: str
    byte_size: int
    extracted_text: str | None
    qr_json: dict | None
    emisor_cuit: str | None
    pto_vta: str | None
    tipo_cmp: str | None
    nro_cmp: str | None
    cae: str | None
    fecha: date | None
    importe: Decimal | None
    moneda: str | None
    ctz: Decimal | None


class AbstractDocumentStore(ABC):
    """Async store for the original invoice document and its metadata (ADR-071)."""

    @abstractmethod
    async def save(
        self,
        *,
        transaction_id: UUID,
        pdf_bytes: bytes,
        content_type: str,
        byte_size: int,
        extracted_text: str | None,
        qr_json: dict | None,
        emisor_cuit: str | None,
        pto_vta: str | None,
        tipo_cmp: str | None,
        nro_cmp: str | None,
        cae: str | None,
        fecha: date | None,
        importe: Decimal | None,
        moneda: str | None,
        ctz: Decimal | None,
    ) -> None:
        """Insert one document row for a transaction (ADR-071).

        Args:
            transaction_id: The transaction this document belongs to (1:1).
            pdf_bytes: The original uploaded PDF bytes.
            content_type: The MIME type of the upload.
            byte_size: The PDF size in bytes.
            extracted_text: Parsed text, or ``None``.
            qr_json: Decoded QR payload, or ``None``.
            emisor_cuit: Issuer CUIT from the natural key, or ``None``.
            pto_vta: Point of sale from the natural key, or ``None``.
            tipo_cmp: Voucher type code from the natural key, or ``None``.
            nro_cmp: Voucher number from the natural key, or ``None``.
            cae: Electronic authorization code, or ``None``.
            fecha: Invoice date, or ``None``.
            importe: Invoice total in its original currency, or ``None``.
            moneda: Currency code, or ``None``.
            ctz: Exchange rate from the invoice, or ``None``.
        """

    @abstractmethod
    async def get(self, transaction_id: UUID) -> InvoiceDocument | None:
        """Return the stored document for a transaction, or ``None`` when absent.

        Args:
            transaction_id: The transaction whose document to fetch.

        Returns:
            The :class:`InvoiceDocument` read model, or ``None`` when no document
            exists for the transaction.
        """

    @abstractmethod
    async def exists_by_natural_key(
        self,
        *,
        emisor_cuit: str | None,
        pto_vta: str | None,
        tipo_cmp: str | None,
        nro_cmp: str | None,
    ) -> bool:
        """Return whether a document already matches the invoice natural key (ADR-071).

        Backs the advisory dedupe check: the caller warns the user but does not
        block, so a legitimate re-import remains possible.

        Args:
            emisor_cuit: Issuer CUIT from the natural key.
            pto_vta: Point of sale from the natural key.
            tipo_cmp: Voucher type code from the natural key.
            nro_cmp: Voucher number from the natural key.

        Returns:
            ``True`` when a stored document matches all four fields, else ``False``.
        """
