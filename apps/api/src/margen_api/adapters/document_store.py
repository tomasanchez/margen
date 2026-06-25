"""SQLAlchemy adapter for the invoice document storage port (ADR-071).

Persists the original PDF (``BYTEA``), its extracted text and QR ``JSONB``, and
the invoice natural-key fields in the ``invoice_document`` table, on the unit of
work's session (ADR-070). ``exists_by_natural_key`` backs the advisory dedupe
check (warn, not block — ADR-071). All I/O is awaited (AGENTS.md). A future Azure
Blob adapter would implement the same port without touching callers (ADR-073).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.invoice_document import InvoiceDocumentRecord
from margen_api.service_layer.document_store import AbstractDocumentStore, InvoiceDocument


class SqlAlchemyDocumentStore(AbstractDocumentStore):
    """Persist invoice documents through an async session (ADR-071)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the store.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    async def save(
        self,
        *,
        transaction_id: UUID,
        user_id: str | None,
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
        """Stage one document row for the next commit (ADR-071, ADR-108).

        The ownership column is a nullable UUID (ADR-094); the owner arrives as a
        string (the Supabase ``sub``), so it is coerced on the way down to mirror the
        transaction repository's mapper.
        """
        self.session.add(
            InvoiceDocumentRecord(
                transaction_id=transaction_id,
                user_id=UUID(user_id) if user_id is not None else None,
                pdf_bytes=pdf_bytes,
                content_type=content_type,
                byte_size=byte_size,
                extracted_text=extracted_text,
                qr_json=qr_json,
                emisor_cuit=emisor_cuit,
                pto_vta=pto_vta,
                tipo_cmp=tipo_cmp,
                nro_cmp=nro_cmp,
                cae=cae,
                fecha=fecha,
                importe=importe,
                moneda=moneda,
                ctz=ctz,
            )
        )

    async def get(self, transaction_id: UUID, user_id: str) -> InvoiceDocument | None:
        """Return the owner's stored document for a transaction, or ``None`` (ADR-108, ADR-111)."""
        statement = (
            select(InvoiceDocumentRecord)
            .where(
                InvoiceDocumentRecord.transaction_id == transaction_id,
                InvoiceDocumentRecord.user_id == UUID(user_id),
            )
            .limit(1)
        )
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _to_read_model(record)

    async def exists_by_natural_key(
        self,
        *,
        emisor_cuit: str | None,
        pto_vta: str | None,
        tipo_cmp: str | None,
        nro_cmp: str | None,
    ) -> bool:
        """Return whether a document already matches the invoice natural key (ADR-071)."""
        statement = (
            select(InvoiceDocumentRecord.id)
            .where(
                InvoiceDocumentRecord.emisor_cuit == emisor_cuit,
                InvoiceDocumentRecord.pto_vta == pto_vta,
                InvoiceDocumentRecord.tipo_cmp == tipo_cmp,
                InvoiceDocumentRecord.nro_cmp == nro_cmp,
            )
            .limit(1)
        )
        return (await self.session.execute(statement)).first() is not None


def _to_read_model(record: InvoiceDocumentRecord) -> InvoiceDocument:
    """Project a stored record into the download read model (ADR-071)."""
    return InvoiceDocument(
        transaction_id=record.transaction_id,
        pdf_bytes=record.pdf_bytes,
        content_type=record.content_type,
        byte_size=record.byte_size,
        extracted_text=record.extracted_text,
        qr_json=record.qr_json,
        emisor_cuit=record.emisor_cuit,
        pto_vta=record.pto_vta,
        tipo_cmp=record.tipo_cmp,
        nro_cmp=record.nro_cmp,
        cae=record.cae,
        fecha=record.fecha,
        importe=record.importe,
        moneda=record.moneda,
        ctz=record.ctz,
    )
