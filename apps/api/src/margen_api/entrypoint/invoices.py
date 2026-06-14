"""Invoice import REST entrypoint (ADR-070, ADR-073).

Hosts the stateless ``POST /invoices/parse`` upload endpoint that runs the ARCA
parser (ADR-069) and returns the extracted/mapped fields, the parse status, the
computed natural key, and an advisory duplicate flag under the ``ResponseModel``
envelope (ADR-030) — with NO persistence (ADR-070). The frontend prefills the
Add/Edit form from this response, the user confirms, and the existing transaction
create path persists (and optionally attaches) the document.

Also exposes ``GET /invoices/{transaction_id}/document`` to stream a stored PDF
back for the attachment badge (ADR-072), reading through the ``DocumentStore``
port's download read model.

Upload safety is enforced here at the boundary (ADR-073): PDF only, validated by
``Content-Type`` AND the ``%PDF`` magic bytes, with a size cap. A non-PDF answers
``415``, an oversized upload ``413``, and an empty/unreadable upload ``422``. An
unparseable but otherwise valid PDF returns ``200`` with ``status=unparseable`` so
the UI can offer a calm manual fallback (ADR-072) rather than surfacing an error.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import Response

from margen_api.entrypoint.dependencies import DocumentReader
from margen_api.entrypoint.invoices_schemas import InvoiceParseResponse
from margen_api.entrypoint.schemas import ResponseModel
from margen_api.service_layer.invoice_parser import parse_invoice
from margen_api.service_layer.invoice_parser_read_models import InvoiceNaturalKey

log = logging.getLogger(__name__)

router = APIRouter(prefix="/invoices", tags=["Invoices"])

# Accepted upload MIME type and the leading magic bytes every PDF starts with.
_PDF_CONTENT_TYPE = "application/pdf"
_PDF_MAGIC = b"%PDF"

# Upload size cap (ADR-073). 10 MiB comfortably covers a single ARCA invoice PDF.
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def _validate_pdf_upload(file: UploadFile, content: bytes) -> None:
    """Enforce the PDF-only, size-capped upload contract (ADR-073).

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


def _dedupe_key(natural_key: InvoiceNaturalKey | None) -> dict[str, str | None] | None:
    """Project a parsed natural key into the string-typed dedupe lookup (ADR-071).

    The document store keys dedupe on string columns, while the parser models the
    numeric fields as ``int``; this coerces them so the advisory lookup matches.

    Args:
        natural_key: The parsed fiscal identity, or ``None`` when not derivable.

    Returns:
        The keyword arguments for ``exists_by_natural_key``, or ``None`` when no
        natural key was derived (the caller then reports ``duplicate=False``).
    """
    if natural_key is None:
        return None
    return {
        "emisor_cuit": natural_key.emisor_cuit,
        "pto_vta": str(natural_key.pto_vta) if natural_key.pto_vta is not None else None,
        "tipo_cmp": str(natural_key.tipo_cmp) if natural_key.tipo_cmp is not None else None,
        "nro_cmp": str(natural_key.nro_cmp) if natural_key.nro_cmp is not None else None,
    }


@router.post(
    "/parse",
    name="Parse invoice",
    status_code=status.HTTP_200_OK,
    response_model=ResponseModel[InvoiceParseResponse],
)
async def parse_invoice_upload(
    file: UploadFile,
    documents: DocumentReader,
) -> ResponseModel[InvoiceParseResponse]:
    """Parse an uploaded ARCA invoice PDF into prefill fields, statelessly (ADR-070).

    Validates the upload (PDF-only, size-capped — ADR-073), runs the parser
    (ADR-069), and returns the mapped transaction fields, parse status, computed
    natural key, and an advisory ``duplicate`` flag — with no persistence. An
    unparseable PDF returns ``200`` with ``status=unparseable`` and empty fields so
    the UI offers a calm manual fallback (ADR-072).
    """
    content = await file.read()
    _validate_pdf_upload(file, content)

    parsed = parse_invoice(content)

    duplicate = False
    lookup = _dedupe_key(parsed.natural_key)
    if lookup is not None:
        duplicate = await documents.exists_by_natural_key(**lookup)

    return ResponseModel(data=InvoiceParseResponse.from_parsed(parsed, duplicate=duplicate))


@router.get(
    "/{transaction_id}/document",
    name="Download invoice document",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={
        status.HTTP_200_OK: {"content": {_PDF_CONTENT_TYPE: {}}, "description": "The stored invoice PDF."},
        status.HTTP_404_NOT_FOUND: {"description": "No document is attached to the transaction."},
    },
)
async def download_invoice_document(
    transaction_id: UUID,
    documents: DocumentReader,
) -> Response:
    """Stream the PDF stored for a transaction's invoice attachment (ADR-072).

    Reads the download read model through the ``DocumentStore`` port and returns
    the original bytes with the stored content type. Raises ``404`` when no
    document is attached to the transaction.
    """
    document = await documents.get(transaction_id)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No invoice document is attached to transaction {transaction_id}.",
        )
    return Response(
        content=document.pdf_bytes,
        media_type=document.content_type,
        headers={"Content-Disposition": f'inline; filename="invoice-{transaction_id}.pdf"'},
    )
