"""SQLAlchemy adapter for the statement document storage port (ADR-077).

Persists the original statement PDF (``BYTEA``), its extracted text, and the
statement natural-key fields in the ``statement_document`` table, on the unit of
work's session (ADR-078). :meth:`save` flushes so the generated id is available to
link the imported transactions in the same unit of work.
``exists_by_natural_key`` backs the advisory dedupe check (warn, not block —
ADR-077). All I/O is awaited (AGENTS.md). A future Azure Blob adapter would
implement the same port without touching callers (ADR-077).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from margen_api.adapters.models.statement_document import StatementDocumentRecord
from margen_api.service_layer.statement_store import AbstractStatementStore, StatementDocument


class SqlAlchemyStatementStore(AbstractStatementStore):
    """Persist statement documents through an async session (ADR-077)."""

    def __init__(self, session: AsyncSession) -> None:
        """Initialize the store.

        Args:
            session: The async session that owns the current transaction.
        """
        self.session = session

    async def save(
        self,
        *,
        pdf_bytes: bytes,
        content_type: str,
        byte_size: int,
        extracted_text: str | None,
        bank_name: str | None,
        network: str | None,
        card_last4: str | None,
        issuer_cuit: str | None,
        statement_number: str | None,
        period_close: date | None,
        period_due: date | None,
        total_amount: Decimal | None,
    ) -> UUID:
        """Stage one statement document row and return its generated id (ADR-077).

        The row is flushed so the server-generated ``id`` is populated and can be
        used as the FK each imported transaction links back to, all within the same
        unit of work (ADR-078).
        """
        record = StatementDocumentRecord(
            pdf_bytes=pdf_bytes,
            content_type=content_type,
            byte_size=byte_size,
            extracted_text=extracted_text,
            bank_name=bank_name,
            network=network,
            card_last4=card_last4,
            issuer_cuit=issuer_cuit,
            statement_number=statement_number,
            period_close=period_close,
            period_due=period_due,
            total_amount=total_amount,
        )
        self.session.add(record)
        await self.session.flush([record])
        return record.id

    async def get(self, statement_document_id: UUID) -> StatementDocument | None:
        """Return the stored document by identity, or ``None`` when absent."""
        statement = select(StatementDocumentRecord).where(StatementDocumentRecord.id == statement_document_id).limit(1)
        record = (await self.session.execute(statement)).scalar_one_or_none()
        if record is None:
            return None
        return _to_read_model(record)

    async def exists_by_natural_key(
        self,
        *,
        issuer_cuit: str | None,
        card_last4: str | None,
        statement_number: str | None,
    ) -> bool:
        """Return whether a document already matches the statement natural key (ADR-077)."""
        statement = (
            select(StatementDocumentRecord.id)
            .where(
                StatementDocumentRecord.issuer_cuit == issuer_cuit,
                StatementDocumentRecord.card_last4 == card_last4,
                StatementDocumentRecord.statement_number == statement_number,
            )
            .limit(1)
        )
        return (await self.session.execute(statement)).first() is not None


def _to_read_model(record: StatementDocumentRecord) -> StatementDocument:
    """Project a stored record into the download read model (ADR-077)."""
    return StatementDocument(
        id=record.id,
        pdf_bytes=record.pdf_bytes,
        content_type=record.content_type,
        byte_size=record.byte_size,
        extracted_text=record.extracted_text,
        bank_name=record.bank_name,
        network=record.network,
        card_last4=record.card_last4,
        issuer_cuit=record.issuer_cuit,
        statement_number=record.statement_number,
        period_close=record.period_close,
        period_due=record.period_due,
        total_amount=record.total_amount,
    )
