"""Storage port for the stored credit-card statement document (ADR-077).

A small storage abstraction over the original statement PDF and its import
metadata. The only adapter today is Postgres (``BYTEA`` in the
``statement_document`` table); a future Azure Blob adapter becomes a drop-in by
storing a blob reference instead of bytes without touching callers (ADR-077,
mirroring ADR-071). Unlike the invoice 1:1 relationship, one statement document
backs many transactions (ADR-077): :meth:`save` returns the new document id so the
import handler can link each created transaction to it. Money is carried as
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
class StatementDocument:
    """Read model for downloading a stored statement document (ADR-077).

    Carries the original bytes plus the metadata a download needs, kept separate
    from the write aggregate so the query side evolves independently.

    Attributes:
        id: The statement document identity (the FK target of its transactions).
        pdf_bytes: The original uploaded PDF bytes.
        content_type: The stored MIME type (e.g. ``application/pdf``).
        byte_size: The PDF size in bytes.
        extracted_text: Parsed text, or ``None`` when no text was extracted.
        bank_name: The issuing bank name, if parsed.
        network: The card network, if parsed.
        card_last4: Last four digits of the card, if parsed.
        issuer_cuit: Issuing bank CUIT, if parsed.
        statement_number: The statement's printed number, if parsed.
        period_close: The current-statement closing date, if parsed.
        period_due: The current-statement due date, if parsed.
        total_amount: The pesos statement total, if parsed.
    """

    id: UUID
    pdf_bytes: bytes
    content_type: str
    byte_size: int
    extracted_text: str | None
    bank_name: str | None
    network: str | None
    card_last4: str | None
    issuer_cuit: str | None
    statement_number: str | None
    period_close: date | None
    period_due: date | None
    total_amount: Decimal | None


class AbstractStatementStore(ABC):
    """Async store for the original statement document and its metadata (ADR-077)."""

    @abstractmethod
    async def save(
        self,
        *,
        user_id: str | None,
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
        """Insert one statement document row and return its new identity (ADR-077, ADR-108).

        The returned id is the FK target each imported transaction links back to,
        so the import handler stages the document, flushes, then attaches the id to
        every created line in the same unit of work (ADR-078).

        Args:
            user_id: The authenticated owner the document is attributed to, mirroring
                its imported transactions' owner so the bytes are owner-scoped on
                download (ADR-108); ``None`` only for legacy/unowned rows.
            pdf_bytes: The original uploaded PDF bytes.
            content_type: The MIME type of the upload.
            byte_size: The PDF size in bytes.
            extracted_text: Parsed text, or ``None``.
            bank_name: The issuing bank name, or ``None``.
            network: The card network, or ``None``.
            card_last4: Last four digits of the card, or ``None``.
            issuer_cuit: Issuing bank CUIT, or ``None``.
            statement_number: The statement's printed number, or ``None``.
            period_close: The current-statement closing date, or ``None``.
            period_due: The current-statement due date, or ``None``.
            total_amount: The pesos statement total, or ``None``.

        Returns:
            The UUID identity of the newly staged statement document.
        """

    @abstractmethod
    async def get(self, statement_document_id: UUID, user_id: str) -> StatementDocument | None:
        """Return the owner's stored document by identity, or ``None`` (ADR-108, ADR-111).

        Scopes the lookup by ``user_id`` (filter-in-reader) so another user's document
        id is simply not found — the download endpoint maps that to a 404 before any
        bytes are read, so foreign PDFs never leak (ADR-081, ADR-111).

        Args:
            statement_document_id: The statement document to fetch.
            user_id: The authenticated owner the lookup is scoped to.

        Returns:
            The :class:`StatementDocument` read model, or ``None`` when no document
            owned by ``user_id`` matches the identity.
        """

    @abstractmethod
    async def exists_by_natural_key(
        self,
        *,
        issuer_cuit: str | None,
        card_last4: str | None,
        statement_number: str | None,
    ) -> bool:
        """Return whether a document already matches the statement natural key (ADR-077).

        Backs the advisory dedupe check: the caller warns the user but does not
        block, so a legitimate re-import remains possible.

        Args:
            issuer_cuit: Issuing bank CUIT from the natural key.
            card_last4: Last four digits of the card from the natural key.
            statement_number: The statement's printed number from the natural key.

        Returns:
            ``True`` when a stored document matches all three fields, else ``False``.
        """
