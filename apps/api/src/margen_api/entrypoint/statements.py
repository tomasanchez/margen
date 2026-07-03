"""Credit-card statement import REST entrypoint (ADR-078, ADR-081).

Hosts the stateless ``POST /statements/parse`` upload endpoint that runs the bank
parser registry (ADR-076) and returns the detected bank identity, the editable
line drafts, the document payload (base64 PDF + metadata), the computed natural
key, and an advisory duplicate flag under the ``ResponseModel`` envelope (ADR-030)
— with NO persistence (ADR-078). The review UI lets the user confirm/edit the
lines, then ``POST /statements/import`` saves the statement document once and
bulk-creates every confirmed line as an EXPENSE transaction in a single unit of
work (ADR-078).

Also exposes ``GET /statements/{statement_document_id}/document`` to stream a
stored PDF back, reading through the ``StatementStore`` port's download read model.

Upload safety is enforced here at the boundary (ADR-081, mirroring ADR-073): PDF
only, validated by ``Content-Type`` AND the ``%PDF`` magic bytes, with a 10 MiB
size cap. A non-PDF answers ``415``, an oversized upload ``413``, and an
empty/unreadable upload ``422``. An unsupported issuer returns ``200`` with
``status=unsupported`` so the UI can offer a calm manual fallback (ADR-080) rather
than surfacing an error.
"""

from __future__ import annotations

import datetime
import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import Response

from margen_api.domain.commands.statement import StatementImportResult
from margen_api.domain.models.exceptions import AccountNotFoundError, MergeTargetNotFoundError
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.entrypoint.dependencies import AuthUser, Bus, StatementReader, TransactionReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.statements_schemas import (
    InvalidDocumentBase64Error,
    StatementImportRequest,
    StatementImportResponse,
    StatementParseResponse,
)
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.statement_matcher import WINDOW_DAYS, ReconCandidate, match_lines
from margen_api.service_layer.statement_parser import parse_statement
from margen_api.service_layer.statement_parser_read_models import ParsedStatement, StatementNaturalKey

log = logging.getLogger(__name__)

router = APIRouter(prefix="/statements", tags=["Statements"])

# Accepted upload MIME type and the leading magic bytes every PDF starts with.
_PDF_CONTENT_TYPE = "application/pdf"
_PDF_MAGIC = b"%PDF"

# Upload size cap (ADR-081). 10 MiB comfortably covers a single CC statement PDF.
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def _validate_pdf_upload(file: UploadFile, content: bytes) -> None:
    """Enforce the PDF-only, size-capped upload contract (ADR-081).

    Args:
        file: The multipart upload, used for its declared ``content_type``.
        content: The already-read upload bytes.

    Raises:
        HTTPException: ``415`` when the type/magic is not PDF, ``413`` when the
            upload exceeds the size cap, ``422`` when the upload is empty.
    """
    if not content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The uploaded file is empty.",
        )
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"The uploaded file exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    if file.content_type != _PDF_CONTENT_TYPE or not content.startswith(_PDF_MAGIC):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Only PDF files are accepted.",
        )


def _dedupe_key(natural_key: StatementNaturalKey | None) -> dict[str, str | None] | None:
    """Project a parsed natural key into the dedupe lookup kwargs (ADR-077).

    Args:
        natural_key: The parsed statement identity, or ``None`` when not derivable.

    Returns:
        The keyword arguments for ``exists_by_natural_key``, or ``None`` when no
        natural key was derived (the caller then reports ``duplicate=False``).
    """
    if natural_key is None:
        return None
    return {
        "issuer_cuit": natural_key.issuer_cuit,
        "card_last4": natural_key.card_last4,
        "statement_number": natural_key.statement_number,
    }


def _is_manual_expense(transaction: TransactionReadModel) -> bool:
    """Return whether a transaction is a manual-expense reconciliation candidate (ADR-084).

    A candidate is an expense the user entered by hand — kind ``expense`` and not yet
    linked to any statement document — so already-imported statement rows are never
    re-matched (ADR-084).
    """
    return transaction.kind is Kind.EXPENSE and transaction.statement_document_id is None


async def _candidate_pool(
    parsed: ParsedStatement,
    transactions: AbstractTransactionReader,
    user_id: str,
) -> list[ReconCandidate]:
    """Fetch the owner's manual-expense candidates within the statement window (ADR-085).

    Reads the owner's existing transactions through the query reader (scoped to
    ``user_id``, ADR-108), keeps only manual expenses (kind expense,
    ``statement_document_id`` null) whose ``occurred_on`` falls within
    ``[min(line purchase date) - WINDOW_DAYS, max(line purchase date) + WINDOW_DAYS]``
    spanning all parsed lines, and projects them into pure :class:`ReconCandidate`
    records for the matcher. The window is built on each line's **purchase date**
    (FECHA) — the date the user would have logged the manual expense — to mirror the
    matcher's date condition (ADR-089). Returns an empty list when the statement has
    no lines.

    Args:
        parsed: The parse result whose lines define the date window.
        transactions: The query-side reader for existing transactions.
        user_id: The authenticated owner whose manual expenses are candidates.

    Returns:
        The manual-expense candidate records within the window.
    """
    if not parsed.lines:
        return []

    window = datetime.timedelta(days=WINDOW_DAYS)
    line_dates = [line.purchase_date for line in parsed.lines]
    lower = min(line_dates) - window
    upper = max(line_dates) + window

    return [
        ReconCandidate(
            transaction_id=transaction.id,
            occurred_on=transaction.occurred_on,
            name=transaction.name,
            amount=transaction.amount,
            currency=transaction.currency.value,
            category=transaction.category,
            payment_method=transaction.payment_method,
        )
        for transaction in await transactions.list_transactions(user_id)
        if _is_manual_expense(transaction)
        and transaction.currency is Currency.ARS
        and lower <= transaction.occurred_on <= upper
    ]


@router.post(
    "/parse",
    name="Parse statement",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[StatementParseResponse],
)
async def parse_statement_upload(
    file: UploadFile,
    statements: StatementReader,
    transactions: TransactionReader,
    user: AuthUser,
) -> ResponseModel[StatementParseResponse]:
    """Parse an uploaded CC statement PDF into editable line drafts, statelessly (ADR-078).

    Validates the upload (PDF-only, size-capped — ADR-081), runs the bank parser
    registry (ADR-076), reconciles each parsed line against the user's existing manual
    expenses (ADR-084, ADR-085), and returns the detected bank identity, the editable
    line drafts (each carrying a ``match`` when one was flagged), the document payload
    to echo back on import, the computed natural key, and an advisory ``duplicate``
    flag — with no persistence. An unsupported issuer returns ``200`` with
    ``status=unsupported`` and no lines so the UI offers a calm manual fallback (ADR-080).
    """
    content = await file.read()
    _validate_pdf_upload(file, content)

    parsed = parse_statement(content)

    duplicate = False
    lookup = _dedupe_key(parsed.natural_key)
    if lookup is not None:
        duplicate = await statements.exists_by_natural_key(**lookup)

    candidates = await _candidate_pool(parsed, transactions, user.id)
    matches = match_lines(parsed.lines, candidates)

    return ResponseModel(data=StatementParseResponse.from_parsed(parsed, content, duplicate=duplicate, matches=matches))


@router.post(
    "/import",
    name="Import statement",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[StatementImportResponse],
)
async def import_statement_endpoint(
    body: StatementImportRequest,
    bus: Bus,
    user: AuthUser,
) -> ResponseModel[StatementImportResponse]:
    """Import the confirmed statement lines, resolving each per-line (ADR-078, ADR-085).

    Decodes the echoed-back document payload and dispatches an ``ImportStatement``
    command, which saves the statement document once then resolves each confirmed
    line in a single unit of work (ADR-078): ``import``/``keep_both`` create a new
    EXPENSE while ``merge`` enriches the existing transaction (ADR-085). Returns the
    created and merged counts and ids and the shared ``statementDocumentId``. A
    malformed ``pdfBase64`` yields ``422``; a ``merge`` pointing at a missing
    transaction yields ``409`` (ADR-078, ADR-085); a line attaching a missing or
    cross-tenant ``accountId`` yields ``404`` (ADR-184, ADR-130).
    """
    try:
        command = body.to_command(user.id)
    except InvalidDocumentBase64Error as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    try:
        result: StatementImportResult = await bus.handle(command)
    except AccountNotFoundError as error:
        # Attaching a line to a missing/cross-tenant account is a not-found, never a
        # leak of another tenant's account roster (ADR-184, ADR-130, ADR-111).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Account {error.account_id} not found.",
        ) from error
    except MergeTargetNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Merge target transaction {error.transaction_id} not found.",
        ) from error

    return ResponseModel(
        data=StatementImportResponse(
            statement_document_id=str(result.statement_document_id),
            created_count=len(result.created_transaction_ids),
            merged_count=len(result.merged_transaction_ids),
            created_transaction_ids=[str(tx_id) for tx_id in result.created_transaction_ids],
            merged_transaction_ids=[str(tx_id) for tx_id in result.merged_transaction_ids],
        )
    )


@router.get(
    "/{statement_document_id}/document",
    name="Download statement document",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={
        status.HTTP_200_OK: {"content": {_PDF_CONTENT_TYPE: {}}, "description": "The stored statement PDF."},
        status.HTTP_404_NOT_FOUND: {"description": "No statement document matches the identity."},
    },
)
async def download_statement_document(
    statement_document_id: UUID,
    statements: StatementReader,
    user: AuthUser,
) -> Response:
    """Stream the owner's stored statement PDF by document identity (ADR-078, ADR-108).

    Reads the download read model through the ``StatementStore`` port scoped to
    ``user.id`` (filter-in-reader) and returns the original bytes with the stored
    content type. A document id that does not exist OR that belongs to another user
    both raise ``404`` before any bytes are read — existence is never leaked and a
    foreign PDF never streams (ADR-081, ADR-111).
    """
    document = await statements.get(statement_document_id, user.id)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No statement document {statement_document_id} found.",
        )
    return Response(
        content=document.pdf_bytes,
        media_type=document.content_type,
        headers={"Content-Disposition": f'inline; filename="statement-{statement_document_id}.pdf"'},
    )
