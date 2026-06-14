"""Route tests for the invoice import entrypoint (ADR-070, ADR-073, ADR-074).

Per ADR-032/074 these drive the FastAPI app through the ASGI client **fully
mocked**, with NO native ``zbar``/PyMuPDF and NO SQL: the parser
(``invoices.parse_invoice``) is monkeypatched to return a canned
:class:`ParsedInvoice`, ``get_document_store`` resolves an in-memory
:class:`FakeDocumentStore`, and the create-with-attachment flow uses a real
:class:`MessageBus` over a shared :class:`FakeUnitOfWork`. They assert the upload
safety contract (415/413/422), the ``{data}`` envelope + camelCase + Decimal
money + the mapped fields + parse status, the advisory ``duplicate`` flag, the
calm UNPARSEABLE outcome, the attachment save through the unit of work, and the
document download (200/404).
"""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import bootstrap
from margen_api.entrypoint import invoices
from margen_api.entrypoint.dependencies import get_bus, get_document_store, get_transaction_reader
from margen_api.service_layer.document_store import InvoiceDocument
from margen_api.service_layer.invoice_parser_read_models import (
    ArcaQrData,
    InvoiceNaturalKey,
    ParsedInvoice,
    ParseStatus,
)
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.settings.database_settings import DatabaseSettings
from tests.fakes.persistence import FakeTransactionReader, FakeUnitOfWork

INVOICES = "/api/v1/invoices"
TRANSACTIONS = "/api/v1/transactions"

# Minimal valid %PDF-prefixed bytes: the boundary only checks the magic header,
# and the parser is mocked so no real decode happens.
_PDF_BYTES = b"%PDF-1.4 fake invoice body"


def _qr() -> ArcaQrData:
    """Build a representative decoded ARS QR for the happy path."""
    return ArcaQrData(
        ver=1,
        fecha=date(2026, 6, 12),
        cuit="20304050607",
        pto_vta=5,
        tipo_cmp=11,
        nro_cmp=1234,
        importe=Decimal("150000.50"),
        moneda="PES",
        ctz=Decimal("1"),
        tipo_cod_aut="E",
        cod_aut="70123456789012",
        nro_doc_rec="27111111114",
    )


def _ok_qr_parse() -> ParsedInvoice:
    """A successful QR parse carrying a natural key and client name."""
    qr = _qr()
    return ParsedInvoice(
        status=ParseStatus.OK_QR,
        qr=qr,
        extracted_text="Apellido y Nombre / Razón Social: Acme SRL",
        client_name="Acme SRL",
        natural_key=InvoiceNaturalKey(
            emisor_cuit=qr.cuit,
            pto_vta=qr.pto_vta,
            tipo_cmp=qr.tipo_cmp,
            nro_cmp=qr.nro_cmp,
        ),
    )


@pytest.fixture(name="uow")
def fixture_uow() -> FakeUnitOfWork:
    """Provide a single shared in-memory unit of work for the app under test."""
    return FakeUnitOfWork()


@pytest.fixture(name="client")
async def fixture_client(uow: FakeUnitOfWork) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose bus, reader and document store are mocked.

    The bus is real (the create command flows through the registered handler) but
    its unit of work is the shared :class:`FakeUnitOfWork`; the transaction reader
    reads that same committed store; the document store dependency resolves the
    unit of work's own :class:`FakeDocumentStore` so a saved attachment and the
    advisory dedupe check share state. The container is bootstrapped on in-memory
    SQLite only to satisfy ``get_application`` — its engine is never touched.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)

    bus = MessageBus(
        uow_factory=lambda: uow,
        command_handlers=dict(COMMAND_HANDLERS),
        event_handlers={event: list(handlers) for event, handlers in EVENT_HANDLERS.items()},
    )
    reader = FakeTransactionReader(uow.committed_aggregates)

    app.dependency_overrides[get_bus] = lambda: bus
    app.dependency_overrides[get_transaction_reader] = lambda: reader
    app.dependency_overrides[get_document_store] = lambda: uow.documents

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await container.shutdown()


def _pdf_upload(content: bytes = _PDF_BYTES, *, content_type: str = "application/pdf") -> dict:
    """Build the multipart ``files`` kwarg for the parse endpoint."""
    return {"file": ("invoice.pdf", content, content_type)}


class TestParseInvoice:
    """POST /invoices/parse runs the parser and returns the prefill envelope."""

    async def test_happy_path_returns_mapped_fields(self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a valid PDF whose parser returns an OK_QR ARS invoice
        WHEN the parse endpoint is posted
        THEN it returns 200 with the {data} envelope carrying the camelCase mapped
             fields, Decimal-string money, the parse status and the natural key
        """
        # GIVEN
        monkeypatch.setattr(invoices, "parse_invoice", lambda _content: _ok_qr_parse())

        # WHEN
        response = await client.post(f"{INVOICES}/parse", files=_pdf_upload())

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["status"] == "ok_qr"
        assert data["name"] == "Acme SRL"
        assert data["kind"] == "invoice"
        assert data["currency"] == "ARS"
        assert data["amount"] == "150000.50"  # Decimal serialized as a string (ADR-025).
        assert data["occurredOn"] == "2026-06-12"
        assert data["countsTowardMonotributo"] is True
        assert data["naturalKey"] == {
            "emisorCuit": "20304050607",
            "ptoVta": 5,
            "tipoCmp": 11,
            "nroCmp": 1234,
        }

    async def test_duplicate_true_when_store_reports_existing(
        self, client: httpx.AsyncClient, uow: FakeUnitOfWork, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a stored document already matching the parsed natural key
        WHEN the parse endpoint is posted
        THEN the advisory duplicate flag is true
        """
        # GIVEN — a document with the same natural key as the canned parse.
        uow.documents_store[uuid4()] = InvoiceDocument(
            transaction_id=uuid4(),
            pdf_bytes=b"%PDF-old",
            content_type="application/pdf",
            byte_size=8,
            extracted_text=None,
            qr_json=None,
            emisor_cuit="20304050607",
            pto_vta="5",
            tipo_cmp="11",
            nro_cmp="1234",
            cae=None,
            fecha=None,
            importe=None,
            moneda=None,
            ctz=None,
        )
        monkeypatch.setattr(invoices, "parse_invoice", lambda _content: _ok_qr_parse())

        # WHEN
        data = (await client.post(f"{INVOICES}/parse", files=_pdf_upload())).json()["data"]

        # THEN
        assert data["duplicate"] is True

    async def test_duplicate_false_when_store_has_no_match(
        self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN an empty document store
        WHEN the parse endpoint is posted
        THEN the advisory duplicate flag is false
        """
        # GIVEN
        monkeypatch.setattr(invoices, "parse_invoice", lambda _content: _ok_qr_parse())

        # WHEN
        data = (await client.post(f"{INVOICES}/parse", files=_pdf_upload())).json()["data"]

        # THEN
        assert data["duplicate"] is False

    async def test_no_natural_key_reports_not_duplicate(
        self, client: httpx.AsyncClient, uow: FakeUnitOfWork, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a parse result with no derivable natural key (text fallback)
        WHEN the parse endpoint is posted
        THEN the dedupe lookup is skipped and duplicate is false
        """

        # GIVEN — a text-fallback parse with no QR / natural key.
        def _text_fallback(_content: bytes) -> ParsedInvoice:
            return ParsedInvoice(
                status=ParseStatus.OK_TEXT_FALLBACK,
                qr=None,
                extracted_text="some text",
                client_name=None,
                natural_key=None,
            )

        monkeypatch.setattr(invoices, "parse_invoice", _text_fallback)

        # WHEN
        data = (await client.post(f"{INVOICES}/parse", files=_pdf_upload())).json()["data"]

        # THEN
        assert data["status"] == "ok_text_fallback"
        assert data["duplicate"] is False
        assert data["naturalKey"] is None

    async def test_unparseable_returns_200_calm(self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
        """
        GIVEN a valid PDF the parser cannot read (no QR, no text)
        WHEN the parse endpoint is posted
        THEN it returns 200 with status=unparseable and empty fields (calm, not 500)
        """

        # GIVEN
        def _unparseable(_content: bytes) -> ParsedInvoice:
            return ParsedInvoice(
                status=ParseStatus.UNPARSEABLE,
                qr=None,
                extracted_text="",
                client_name=None,
                natural_key=None,
            )

        monkeypatch.setattr(invoices, "parse_invoice", _unparseable)

        # WHEN
        response = await client.post(f"{INVOICES}/parse", files=_pdf_upload())

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["status"] == "unparseable"
        assert data["amount"] is None
        assert data["name"] is None

    async def test_non_pdf_content_type_returns_415(self, client: httpx.AsyncClient):
        """
        GIVEN an upload declared as a non-PDF content type
        WHEN the parse endpoint is posted
        THEN it returns 415 (PDF only)
        """
        # WHEN
        response = await client.post(
            f"{INVOICES}/parse",
            files=_pdf_upload(content_type="text/plain"),
        )

        # THEN
        assert response.status_code == status.HTTP_415_UNSUPPORTED_MEDIA_TYPE

    async def test_missing_pdf_magic_returns_415(self, client: httpx.AsyncClient):
        """
        GIVEN an application/pdf upload whose bytes lack the %PDF magic header
        WHEN the parse endpoint is posted
        THEN it returns 415 (the magic bytes are validated, not just the type)
        """
        # WHEN
        response = await client.post(
            f"{INVOICES}/parse",
            files=_pdf_upload(content=b"not really a pdf"),
        )

        # THEN
        assert response.status_code == status.HTTP_415_UNSUPPORTED_MEDIA_TYPE

    async def test_oversize_returns_413(self, client: httpx.AsyncClient):
        """
        GIVEN a PDF upload exceeding the 10 MiB size cap
        WHEN the parse endpoint is posted
        THEN it returns 413
        """
        # GIVEN — 10 MiB + 1 byte, still %PDF-prefixed.
        oversize = b"%PDF" + b"0" * (10 * 1024 * 1024)

        # WHEN
        response = await client.post(f"{INVOICES}/parse", files=_pdf_upload(content=oversize))

        # THEN
        assert response.status_code == status.HTTP_413_REQUEST_ENTITY_TOO_LARGE

    async def test_empty_upload_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN an empty upload
        WHEN the parse endpoint is posted
        THEN it returns 422
        """
        # WHEN
        response = await client.post(f"{INVOICES}/parse", files=_pdf_upload(content=b""))

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestCreateWithAttachment:
    """POST /transactions with a document stores and links the invoice PDF."""

    def _create_body(self, *, pdf_base64: str) -> dict:
        """Build a create body carrying an invoice document attachment."""
        return {
            "occurredOn": "2026-06-12",
            "name": "Acme SRL",
            "kind": "invoice",
            "amountNum": "150000.50",
            "currency": "ARS",
            "countsTowardMonotributo": True,
            "document": {
                "pdfBase64": pdf_base64,
                "contentType": "application/pdf",
                "extractedText": "Acme SRL invoice",
                "qrJson": {"importe": "150000.50"},
                "emisorCuit": "20304050607",
                "ptoVta": "5",
                "tipoCmp": "11",
                "nroCmp": "1234",
                "cae": "70123456789012",
                "fecha": "2026-06-12",
                "importe": "150000.50",
                "moneda": "ARS",
                "ctz": "1",
            },
        }

    async def test_create_saves_document_through_unit_of_work(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a create body with a base64-encoded invoice PDF attachment
        WHEN the create endpoint is posted
        THEN it returns 201 and the document is saved through the fake unit of work
             with the decoded bytes linked to the created transaction id
        """
        # GIVEN
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")

        # WHEN
        response = await client.post(TRANSACTIONS, json=self._create_body(pdf_base64=encoded))

        # THEN — the transaction was created.
        assert response.status_code == status.HTTP_201_CREATED
        transaction_id = UUID(response.json()["data"]["id"])

        # THEN — the document was saved with the decoded bytes, linked 1:1.
        assert transaction_id in uow.documents_store
        stored = uow.documents_store[transaction_id]
        assert stored.pdf_bytes == _PDF_BYTES
        assert stored.byte_size == len(_PDF_BYTES)
        assert stored.emisor_cuit == "20304050607"
        assert stored.importe == Decimal("150000.50")

    async def test_invalid_base64_returns_422(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a create body whose pdfBase64 is not valid base64
        WHEN the create endpoint is posted
        THEN it returns 422 and nothing was committed
        """
        # WHEN
        response = await client.post(TRANSACTIONS, json=self._create_body(pdf_base64="!!!not-base64!!!"))

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert uow.documents_store == {}
        assert uow.committed_aggregates == {}

    async def test_create_without_document_still_works(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a plain create body with no document (regression)
        WHEN the create endpoint is posted
        THEN it returns 201 and stores no document
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={"occurredOn": "2026-06-12", "name": "Coto", "kind": "expense", "amountNum": "1500.00"},
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED
        assert len(uow.committed_aggregates) == 1
        assert uow.documents_store == {}


class TestDownloadDocument:
    """GET /invoices/{transaction_id}/document streams or 404s the stored PDF."""

    async def test_returns_bytes_and_content_type(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a stored document for a transaction
        WHEN its document is downloaded
        THEN it returns 200 with the original bytes and stored content type
        """
        # GIVEN
        transaction_id = uuid4()
        uow.documents_store[transaction_id] = InvoiceDocument(
            transaction_id=transaction_id,
            pdf_bytes=_PDF_BYTES,
            content_type="application/pdf",
            byte_size=len(_PDF_BYTES),
            extracted_text=None,
            qr_json=None,
            emisor_cuit=None,
            pto_vta=None,
            tipo_cmp=None,
            nro_cmp=None,
            cae=None,
            fecha=None,
            importe=None,
            moneda=None,
            ctz=None,
        )

        # WHEN
        response = await client.get(f"{INVOICES}/{transaction_id}/document")

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.content == _PDF_BYTES
        assert response.headers["content-type"] == "application/pdf"

    async def test_returns_404_when_absent(self, client: httpx.AsyncClient):
        """
        GIVEN no stored document for a transaction id
        WHEN its document is downloaded
        THEN it returns 404
        """
        # WHEN
        response = await client.get(f"{INVOICES}/{uuid4()}/document")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
