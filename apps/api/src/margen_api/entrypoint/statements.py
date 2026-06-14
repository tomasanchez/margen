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

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import Response

from margen_api.domain.commands.statement import StatementImportResult
from margen_api.entrypoint.dependencies import Bus, StatementReader
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.entrypoint.statements_schemas import (
    InvalidDocumentBase64Error,
    StatementImportRequest,
    StatementImportResponse,
    StatementParseResponse,
)
from margen_api.service_layer.statement_parser import parse_statement
from margen_api.service_layer.statement_parser_read_models import StatementNaturalKey

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


@router.post(
    "/parse",
    name="Parse statement",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[StatementParseResponse],
)
async def parse_statement_upload(
    file: UploadFile,
    statements: StatementReader,
) -> ResponseModel[StatementParseResponse]:
    """Parse an uploaded CC statement PDF into editable line drafts, statelessly (ADR-078).

    Validates the upload (PDF-only, size-capped — ADR-081), runs the bank parser
    registry (ADR-076), and returns the detected bank identity, the editable line
    drafts, the document payload to echo back on import, the computed natural key,
    and an advisory ``duplicate`` flag — with no persistence. An unsupported issuer
    returns ``200`` with ``status=unsupported`` and no lines so the UI offers a calm
    manual fallback (ADR-080).
    """
    content = await file.read()
    _validate_pdf_upload(file, content)

    parsed = parse_statement(content)

    duplicate = False
    lookup = _dedupe_key(parsed.natural_key)
    if lookup is not None:
        duplicate = await statements.exists_by_natural_key(**lookup)

    return ResponseModel(data=StatementParseResponse.from_parsed(parsed, content, duplicate=duplicate))


@router.post(
    "/import",
    name="Import statement",
    status_code=status.HTTP_201_CREATED,
    response_model=ResponseModel[StatementImportResponse],
)
async def import_statement_endpoint(
    body: StatementImportRequest,
    bus: Bus,
) -> ResponseModel[StatementImportResponse]:
    """Import the confirmed statement lines as EXPENSE transactions (ADR-078).

    Decodes the echoed-back document payload and dispatches an ``ImportStatement``
    command, which saves the statement document once and bulk-creates one EXPENSE
    transaction per confirmed line in a single unit of work (ADR-078). Returns the
    created count, the transaction ids, and the shared ``statementDocumentId``. A
    malformed ``pdfBase64`` yields ``422`` (ADR-078).
    """
    try:
        command = body.to_command()
    except InvalidDocumentBase64Error as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

    result: StatementImportResult = await bus.handle(command)

    return ResponseModel(
        data=StatementImportResponse(
            statement_document_id=str(result.statement_document_id),
            created_count=len(result.transaction_ids),
            transaction_ids=[str(transaction_id) for transaction_id in result.transaction_ids],
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
) -> Response:
    """Stream the stored statement PDF by document identity (ADR-078).

    Reads the download read model through the ``StatementStore`` port and returns
    the original bytes with the stored content type. Raises ``404`` when no document
    matches the identity.
    """
    document = await statements.get(statement_document_id)
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
