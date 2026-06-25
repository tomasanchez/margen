"""Frozen Pydantic commands for the credit-card statement import (ADR-078).

Commands are immutable, boundary-agnostic requests to change state. Importing a
statement is a single batch use case (ADR-078): one :class:`StatementDocumentPayload`
plus a list of user-confirmed :class:`StatementLineInput` lines. The handler saves
the document once and bulk-creates one EXPENSE transaction per line in the same
unit of work, generating each transaction's server-managed identity and timestamps
itself (never supplied by the caller). Money is ``Decimal`` (ADR-025);
``currency``/``fx_rate_type`` reuse the domain value objects.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from margen_api.domain.messages import Command, Message
from margen_api.domain.models.value_objects import Currency, FxRateType


class StatementLineResolution(StrEnum):
    """How an import line is reconciled against an existing manual expense (ADR-085).

    A flagged line is resolved per-line at review time (ADR-084). The default is
    ``IMPORT`` (no match, or the user just wants a new row).

    Attributes:
        IMPORT: No match found — create a new EXPENSE linked to the statement document.
        MERGE: Match accepted — do NOT create; enrich the existing transaction named
            by ``match_transaction_id`` instead (ADR-085).
        KEEP_BOTH: Match found but the charges are genuinely separate — create a new
            EXPENSE and leave the existing transaction unchanged (ADR-085).
    """

    IMPORT = "import"
    MERGE = "merge"
    KEEP_BOTH = "keep_both"


class StatementDocumentPayload(Message):
    """The statement document stored once for an import batch (ADR-077, ADR-078).

    Carries the uploaded PDF and its statement-level metadata so the import handler
    can persist it as the shared parent of every created transaction through the
    ``StatementStore`` port in the same unit of work (ADR-078). The bytes travel as
    raw :class:`bytes` here — the entrypoint decodes the base64 wire value at the
    boundary so the bytes never enter a transaction aggregate. The natural-key
    fields back the advisory dedupe check; all are optional because a malformed
    statement may not yield every field (ADR-077). Money is ``Decimal`` (ADR-025).

    Attributes:
        pdf_bytes: The original uploaded statement PDF bytes.
        content_type: The MIME type of the upload (``application/pdf``).
        byte_size: The PDF size in bytes.
        extracted_text: Parsed PDF text, or ``None`` when none was extracted.
        bank_name: The issuing bank name, or ``None``.
        network: The card network, or ``None``.
        card_last4: Last four digits of the card, or ``None``.
        issuer_cuit: Issuing bank CUIT, or ``None``.
        statement_number: The statement's printed number, or ``None``.
        period_close: The current-statement closing date, or ``None``.
        period_due: The current-statement due date, or ``None``.
        total_amount: The pesos statement total, or ``None``.
    """

    pdf_bytes: bytes
    content_type: str
    byte_size: int
    extracted_text: str | None = None
    bank_name: str | None = None
    network: str | None = None
    card_last4: str | None = None
    issuer_cuit: str | None = None
    statement_number: str | None = None
    period_close: date | None = None
    period_due: date | None = None
    total_amount: Decimal | None = None


class StatementLineInput(Message):
    """One user-confirmed line to import as an EXPENSE transaction (ADR-079).

    Mirrors the create contract's fields for a single expense. ``kind`` and
    ``counts_toward_monotributo`` are not carried — every imported line is an
    EXPENSE that never counts toward Monotributo (ADR-079), so the handler fixes
    them. Money is ``Decimal`` (ADR-025).

    Attributes:
        occurred_on: The statement pay/due date the expense counts on (ADR-089); the
            original purchase date is preserved in ``notes``.
        name: The merchant / reference label.
        amount: Positive ARS-equivalent magnitude.
        currency: ``ARS`` or ``USD``.
        usd_amount: The stated dollar figure for a USD line, else ``None``.
        fx_rate: The stated cotización for a USD line, else ``None`` (manual confirm).
        fx_rate_type: ``OFFICIAL`` when a rate is stated, else ``None``.
        category: A category label, editable in review, or ``None``.
        payment_method: The composed bank/network/last4 label (e.g.
            ``"Galicia VISA ·5771"``).
        notes: Free-form note, e.g. the installment marker ``"Cuota 3/3"`` (ADR-079).
        resolution: The per-line reconciliation choice (ADR-085); defaults to
            ``IMPORT``.
        match_transaction_id: The existing manual expense to enrich when
            ``resolution`` is ``MERGE``; ``None`` otherwise (ADR-085).
    """

    occurred_on: date
    name: str = Field(min_length=1)
    amount: Decimal = Field(gt=Decimal(0))
    currency: Currency = Currency.ARS
    usd_amount: Decimal | None = None
    fx_rate: Decimal | None = None
    fx_rate_type: FxRateType | None = None
    fx_rate_as_of: datetime | None = None
    category: str | None = None
    payment_method: str | None = None
    notes: str | None = None
    resolution: StatementLineResolution = StatementLineResolution.IMPORT
    match_transaction_id: UUID | None = None


class ImportStatement(Command):
    """Request to import a confirmed credit-card statement as expenses (ADR-078).

    The handler saves the ``document`` once through the ``StatementStore`` port,
    flushes to obtain its id, then builds one EXPENSE transaction per ``lines``
    entry — each linked to the document via ``statement_document_id`` — and commits
    atomically in a single unit of work. It generates every transaction's identity
    and timestamps (ADR-026) and stamps each created/merged transaction with the
    authenticated owner ``user_id`` the entrypoint sets from ``AuthUser.id`` before
    dispatch, so imported rows are owned exactly like manually-created ones
    (ADR-108).
    """

    document: StatementDocumentPayload
    lines: list[StatementLineInput]
    user_id: str


@dataclass(frozen=True, slots=True)
class StatementImportResult:
    """The outcome of an import-statement command (ADR-078).

    Carries the shared statement document id and the created transaction ids so the
    entrypoint can report the count and deep-link to the stored PDF without a
    re-query. A plain dataclass (not a Pydantic schema) — it is a handler return
    value, not a wire contract.

    Attributes:
        statement_document_id: The stored statement document identity.
        created_transaction_ids: The newly created EXPENSE transaction identities
            (``IMPORT`` / ``KEEP_BOTH`` lines), in line order.
        merged_transaction_ids: The existing transaction identities enriched in place
            (``MERGE`` lines), in line order (ADR-085).
    """

    statement_document_id: UUID
    created_transaction_ids: list[UUID]
    merged_transaction_ids: list[UUID]
