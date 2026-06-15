"""Route tests for the credit-card statement import entrypoint (ADR-076..082).

Unlike the invoice e2e tier (which mocks every port), these drive the **REAL**
application container on **in-memory async SQLite** through the shared
``test_client`` fixture (``tests/conftest.py``): the parse → import → download path
exercises the real :class:`SqlAlchemyStatementStore` adapter, the real
``import_statement`` handler over the real unit of work, and the endpoints
together (ADR-019 — the gate comes from unit + e2e). The only thing mocked is the
native PyMuPDF boundary (``statement_parser.extract_text``), monkeypatched to the
canonical SANITIZED Galicia VISA vertical-token text so no native stack is needed
(ADR-082).

They assert: the parse envelope (identity, lines, ``document`` echo, the middot
``paymentMethod``), the upload safety contract (415/413/422), the advisory
``duplicate`` flag against a really-stored statement, the calm UNSUPPORTED and
UNPARSEABLE outcomes at 200, the USD-line vs ARS-line serialization shapes, the
real import (201 + persisted transactions + the linked document), the
malformed-base64 422, and the document download (200 inline bytes / 404).
"""

from __future__ import annotations

import base64
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import status

from margen_api.service_layer import statement_parser

STATEMENTS = "/api/v1/statements"
TRANSACTIONS = "/api/v1/transactions"

# Minimal valid %PDF-prefixed bytes: the boundary only checks the magic header,
# and ``extract_text`` is monkeypatched so no real PyMuPDF decode happens.
_PDF_BYTES = b"%PDF-1.4 fake statement body"

# Canonical SANITIZED Galicia VISA text as PyMuPDF emits it: one table cell per
# line (a vertical token stream), trailing spaces and blank lines preserved.
# Fake name / address / account; real structure (ADR-081). 3 purchases summing to
# 14.521,66; the COM/BONI fee pair nets to zero, so no fee line.
_GALICIA_VISA_TEXT = """\
  Resumen N° VI00000000069436867
 Tarjeta Crédito VISA
JUAN PEREZ
 Consumidor Final
CUIT Banco: 30-50000173-5
CALLE FALSA 123, CIUDAD AUTONOMA BUEN, C0000AAA
 N° Cuenta: 0000000000
Sucursal: 665
Resumen de tarjeta de credito VISA
20260611079436867H
Página
1 / 5
14.521,66
0,00
07-May-26
15-May-26
11-Jun-26
19-Jun-26
08-Jul-26
17-Jul-26
 CONSOLIDADO
PESOS
DÓLARES
SALDO ANTERIOR
612.544,09
0,00
15-05-26

SU PAGO EN PESOS
-612.544,09

DETALLE DEL CONSUMO
FECHA
REFERENCIA
CUOTA
COMPROBANTE
PESOS
DÓLARES
20-03-26
*
MERPAGO*PASSLINE
03/03
524072
3.641,66

08-05-26
K
Express Av Cordoba 3721
005306
10.180,00

14-05-26
K
SUBE VIAJES - BUSES
501892
700,00

TARJETA 5771 Total Consumos de JUAN PEREZ
14.521,66
0,00
11-06-26

COM MANT CTA Y RENO
25.206,00

11-06-26

BONI MANT CTA Y RENO
-25.206,00

TOTAL A PAGAR
14.521,66
0,00
"""

# A Galicia VISA statement carrying one USD purchase (a second DÓLARES money cell),
# so the USD-line serialization branch is exercised end to end. Same fingerprint.
_GALICIA_VISA_USD_TEXT = """\
 Tarjeta Crédito VISA
CUIT Banco: 30-50000173-5
  Resumen N° VI00000000069999999
TARJETA 5771 Total Consumos de JUAN PEREZ
DETALLE DEL CONSUMO
10-05-26
*
Apple Store
004455
120.000,00
100,00
TARJETA 5771 Total Consumos de JUAN PEREZ
TOTAL A PAGAR
120.000,00
"""

# Galicia VISA fingerprint but no extractable detail rows → UNPARSEABLE.
_GALICIA_VISA_EMPTY_TEXT = "Tarjeta Crédito VISA\nCUIT Banco: 30-50000173-5\nResumen N° VI123\n"

# Text no registered bank parser fingerprints → UNSUPPORTED.
_UNSUPPORTED_TEXT = "Some other bank Mastercard statement\nno markers here\n"


def _pdf_upload(content: bytes = _PDF_BYTES, *, content_type: str = "application/pdf") -> dict:
    """Build the multipart ``files`` kwarg for the parse endpoint."""
    return {"file": ("statement.pdf", content, content_type)}


def _mock_extract_text(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    """Monkeypatch the native PyMuPDF text boundary to return canned text (ADR-082)."""
    monkeypatch.setattr(statement_parser, "extract_text", lambda _pdf: text)


def _import_body(*, pdf_base64: str, lines: list[dict] | None = None) -> dict:
    """Build a statement import body with the echoed document and confirmed lines."""
    return {
        "document": {
            "pdfBase64": pdf_base64,
            "contentType": "application/pdf",
            "byteSize": len(_PDF_BYTES),
            "extractedText": "JUAN PEREZ statement",
            "bankName": "Galicia",
            "network": "VISA",
            "cardLast4": "5771",
            "issuerCuit": "30-50000173-5",
            "statementNumber": "VI00000000069436867",
            "periodClose": "2026-06-11",
            "periodDue": "2026-06-19",
            "totalAmount": "14521.66",
        },
        "lines": lines
        if lines is not None
        else [
            {
                "occurredOn": "2026-03-20",
                "name": "MERPAGO*PASSLINE",
                "amount": "3641.66",
                "currency": "ARS",
                "category": "Entertainment",
                "bank": "Galicia VISA ·5771",
                "cuota": "03/03",
            },
            {
                "occurredOn": "2026-05-08",
                "name": "Express Av Cordoba 3721",
                "amount": "10180.00",
                "currency": "ARS",
                "category": "Food",
                "bank": "Galicia VISA ·5771",
            },
            {
                "occurredOn": "2026-05-14",
                "name": "SUBE VIAJES - BUSES",
                "amount": "700.00",
                "currency": "ARS",
                "category": "Transport",
                "bank": "Galicia VISA ·5771",
            },
        ],
    }


async def _create_manual_expense(
    client: httpx.AsyncClient,
    *,
    name: str,
    amount: str,
    occurred_on: str,
    category: str | None = None,
    bank: str | None = None,
    currency: str = "ARS",
) -> str:
    """Create a manual EXPENSE through the real POST /transactions and return its id.

    A manual expense (no statement document) is exactly the reconciliation candidate
    the matcher flags at parse time (ADR-084).
    """
    body: dict = {
        "occurredOn": occurred_on,
        "name": name,
        "kind": "expense",
        "amountNum": amount,
        "currency": currency,
    }
    if category is not None:
        body["category"] = category
    if bank is not None:
        body["bank"] = bank
    response = await client.post(TRANSACTIONS, json=body)
    assert response.status_code == status.HTTP_201_CREATED
    return response.json()["data"]["id"]


def _line(
    *,
    occurred_on: str,
    name: str,
    amount: str,
    resolution: str | None = None,
    match_transaction_id: str | None = None,
    category: str | None = None,
    bank: str | None = None,
) -> dict:
    """Build a single import-request line, with the optional reconciliation choice."""
    line: dict = {"occurredOn": occurred_on, "name": name, "amount": amount, "currency": "ARS"}
    if category is not None:
        line["category"] = category
    if bank is not None:
        line["bank"] = bank
    if resolution is not None:
        line["resolution"] = resolution
    if match_transaction_id is not None:
        line["matchTransactionId"] = match_transaction_id
    return line


class TestParseStatement:
    """POST /statements/parse runs the real parser+endpoint and returns the prefill."""

    async def test_happy_path_returns_identity_lines_and_document(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a valid Galicia VISA PDF (text boundary mocked)
        WHEN the parse endpoint is posted
        THEN it returns 200 with the {data} envelope carrying the bank identity, the
             middot payment-method label, the natural key, the three purchase lines
             and the document echo (no fee line — the COM/BONI pair nets to zero)
        """
        # GIVEN
        _mock_extract_text(monkeypatch, _GALICIA_VISA_TEXT)

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())

        # THEN — envelope + identity.
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["status"] == "ok"
        assert data["duplicate"] is False
        assert data["bankName"] == "Galicia"
        assert data["network"] == "VISA"
        assert data["cardLast4"] == "5771"
        assert data["paymentMethod"] == "Galicia VISA ·5771"  # middot composed label.
        assert data["statementNumber"] == "VI00000000069436867"
        assert data["issuerCuit"] == "30-50000173-5"
        assert data["periodClose"] == "2026-06-11"
        assert data["periodDue"] == "2026-06-19"
        assert data["totalAmount"] == "14521.66"  # Decimal serialized as a string (ADR-025).

        # THEN — the natural key projection.
        assert data["naturalKey"] == {
            "issuerCuit": "30-50000173-5",
            "cardLast4": "5771",
            "statementNumber": "VI00000000069436867",
        }

        # THEN — exactly the three purchases, ARS, with categories.
        names = {line["name"] for line in data["lines"]}
        assert names == {"MERPAGO*PASSLINE", "Express Av Cordoba 3721", "SUBE VIAJES - BUSES"}
        merpago = next(line for line in data["lines"] if line["name"] == "MERPAGO*PASSLINE")
        assert merpago["amount"] == "3641.66"
        assert merpago["currency"] == "ARS"
        assert merpago["cuota"] == "03/03"
        assert merpago["category"] == "Entertainment"
        assert merpago["lineKind"] == "purchase"
        assert merpago["include"] is True
        # An ARS line leaves the USD/fx optionals null (the None-optional branch).
        assert merpago["usdAmount"] is None
        assert merpago["fxRate"] is None
        assert merpago["fxRateType"] is None

        # THEN — the document echo payload to return on import.
        document = data["document"]
        assert base64.b64decode(document["pdfBase64"]) == _PDF_BYTES
        assert document["byteSize"] == len(_PDF_BYTES)
        assert document["bankName"] == "Galicia"
        assert document["cardLast4"] == "5771"
        assert document["periodClose"] == "2026-06-11"
        assert document["totalAmount"] == "14521.66"

    async def test_usd_line_serializes_the_dollar_fields(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a Galicia VISA PDF whose purchase carries a DÓLARES money cell
        WHEN the parse endpoint is posted
        THEN the line serializes as USD with the stated dollar figure present
             (the optional-present branch of the line schema)
        """
        # GIVEN
        _mock_extract_text(monkeypatch, _GALICIA_VISA_USD_TEXT)

        # WHEN
        data = (await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())).json()["data"]

        # THEN
        assert data["status"] == "ok"
        line = next(line for line in data["lines"] if line["name"] == "Apple Store")
        assert line["currency"] == "USD"
        assert line["amount"] == "120000.00"
        assert line["usdAmount"] == "100.00"
        assert line["fxRate"] is None  # left for manual confirmation (ADR-079).
        assert line["fxRateType"] is None

    async def test_duplicate_true_after_a_real_import(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a statement already imported (so its natural key is really stored)
        WHEN the same statement is parsed again
        THEN the advisory duplicate flag is true (the real exists_by_natural_key)
        """
        # GIVEN — import once so the statement_document row exists in SQLite.
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        imported = await test_client.post(f"{STATEMENTS}/import", json=_import_body(pdf_base64=encoded))
        assert imported.status_code == status.HTTP_201_CREATED
        _mock_extract_text(monkeypatch, _GALICIA_VISA_TEXT)

        # WHEN — parse the same statement (same issuer / last4 / number).
        data = (await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())).json()["data"]

        # THEN
        assert data["duplicate"] is True

    async def test_unsupported_issuer_returns_200_calm_without_document(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a PDF no bank parser fingerprints
        WHEN the parse endpoint is posted
        THEN it returns 200 with status=unsupported, no lines and no document echo
             (a calm manual-entry fallback — ADR-080), and duplicate is false
        """
        # GIVEN
        _mock_extract_text(monkeypatch, _UNSUPPORTED_TEXT)

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["status"] == "unsupported"
        assert data["lines"] == []
        assert data["document"] is None
        assert data["bankName"] is None
        assert data["naturalKey"] is None
        assert data["duplicate"] is False

    async def test_unparseable_match_returns_200_calm_with_document(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a Galicia VISA PDF the parser matches but extracts no lines from
        WHEN the parse endpoint is posted
        THEN it returns 200 with status=unparseable and no lines, but still echoes a
             document (the issuer was detected — unlike unsupported)
        """
        # GIVEN
        _mock_extract_text(monkeypatch, _GALICIA_VISA_EMPTY_TEXT)

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["status"] == "unparseable"
        assert data["lines"] == []
        assert data["document"] is not None  # the issuer matched, so there is something to keep.

    async def test_non_pdf_content_type_returns_415(self, test_client: httpx.AsyncClient):
        """
        GIVEN an upload declared as a non-PDF content type
        WHEN the parse endpoint is posted
        THEN it returns 415 (PDF only)
        """
        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload(content_type="text/plain"))

        # THEN
        assert response.status_code == status.HTTP_415_UNSUPPORTED_MEDIA_TYPE

    async def test_missing_pdf_magic_returns_415(self, test_client: httpx.AsyncClient):
        """
        GIVEN an application/pdf upload whose bytes lack the %PDF magic header
        WHEN the parse endpoint is posted
        THEN it returns 415 (the magic bytes are validated, not just the type)
        """
        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload(content=b"not really a pdf"))

        # THEN
        assert response.status_code == status.HTTP_415_UNSUPPORTED_MEDIA_TYPE

    async def test_oversize_returns_413(self, test_client: httpx.AsyncClient):
        """
        GIVEN a PDF upload exceeding the 10 MiB size cap
        WHEN the parse endpoint is posted
        THEN it returns 413
        """
        # GIVEN — 10 MiB + 1 byte, still %PDF-prefixed.
        oversize = b"%PDF" + b"0" * (10 * 1024 * 1024)

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload(content=oversize))

        # THEN
        assert response.status_code == status.HTTP_413_REQUEST_ENTITY_TOO_LARGE

    async def test_empty_upload_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN an empty upload
        WHEN the parse endpoint is posted
        THEN it returns 422
        """
        # WHEN
        response = await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload(content=b""))

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestImportStatement:
    """POST /statements/import saves the document once and bulk-creates expenses."""

    async def test_import_persists_transactions_linked_to_the_document(self, test_client: httpx.AsyncClient):
        """
        GIVEN a confirmed import body (echoed document + three lines)
        WHEN the import endpoint is posted
        THEN it returns 201 with the created count and ids, the lines persist as
             listable transactions, and the shared statementDocumentId downloads back
        """
        # GIVEN
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=_import_body(pdf_base64=encoded))

        # THEN — the import result.
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()["data"]
        assert data["createdCount"] == 3
        assert data["mergedCount"] == 0
        assert data["mergedTransactionIds"] == []
        assert len(data["createdTransactionIds"]) == 3
        # the returned ids are valid UUIDs.
        for transaction_id in data["createdTransactionIds"]:
            UUID(transaction_id)
        statement_document_id = data["statementDocumentId"]
        UUID(statement_document_id)

        # THEN — the three lines really persisted as EXPENSE transactions.
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        imported = {
            row["name"]: row
            for row in listed
            if row["name"]
            in {
                "MERPAGO*PASSLINE",
                "Express Av Cordoba 3721",
                "SUBE VIAJES - BUSES",
            }
        }
        assert set(imported) == {"MERPAGO*PASSLINE", "Express Av Cordoba 3721", "SUBE VIAJES - BUSES"}
        assert imported["MERPAGO*PASSLINE"]["kind"] == "expense"
        assert imported["MERPAGO*PASSLINE"]["amountNum"] == "3641.66"  # money aliased to 'amountNum'.
        assert imported["SUBE VIAJES - BUSES"]["amountNum"] == "700.00"

        # THEN — the document is reachable through the shared statement document id.
        download = await test_client.get(f"{STATEMENTS}/{statement_document_id}/document")
        assert download.status_code == status.HTTP_200_OK
        assert download.content == _PDF_BYTES

    async def test_import_folds_cuota_into_notes(self, test_client: httpx.AsyncClient):
        """
        GIVEN an imported line carrying a cuota marker and no explicit note
        WHEN the import endpoint is posted
        THEN the cuota is folded into the transaction notes as "Cuota 3/3" (ADR-079)
        """
        # GIVEN — a single line with a cuota and no notes.
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                {
                    "occurredOn": "2026-03-20",
                    "name": "MERPAGO*PASSLINE",
                    "amount": "3641.66",
                    "currency": "ARS",
                    "cuota": "3/3",
                }
            ],
        )

        # WHEN
        await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        row = next(line for line in listed if line["name"] == "MERPAGO*PASSLINE")
        assert row["notes"] == "Cuota 3/3"

    async def test_malformed_base64_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN an import body whose document.pdfBase64 is not valid base64
        WHEN the import endpoint is posted
        THEN it returns 422 (ADR-078) and nothing is created
        """
        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=_import_body(pdf_base64="!!!not-base64!!!"))

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        # nothing was created.
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        assert listed == []


class TestParseReconciliation:
    """POST /statements/parse flags likely existing manual expenses per line (ADR-084, ADR-085)."""

    async def test_attaches_match_to_a_matching_manual_expense(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a manual expense matching one statement line (amount, ~name, date in window)
        WHEN the statement is parsed
        THEN that line carries a non-null match with the seeded transactionId, while a
             line with no matching manual expense has match: null
        """
        # GIVEN — a manual expense matching the "Express Av Cordoba 3721" line
        # (amount 10180.00, date 2026-05-08, similar name, no statement document).
        transaction_id = await _create_manual_expense(
            test_client,
            name="Express Cordoba dinner",
            amount="10180.00",
            occurred_on="2026-05-07",
        )
        _mock_extract_text(monkeypatch, _GALICIA_VISA_TEXT)

        # WHEN
        data = (await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())).json()["data"]

        # THEN — the Express line is flagged with the seeded candidate.
        express = next(line for line in data["lines"] if line["name"] == "Express Av Cordoba 3721")
        assert express["match"] is not None
        assert express["match"]["transactionId"] == transaction_id
        assert express["match"]["name"] == "Express Cordoba dinner"
        assert express["match"]["amount"] == "10180.00"

        # THEN — an unrelated line is not flagged.
        sube = next(line for line in data["lines"] if line["name"] == "SUBE VIAJES - BUSES")
        assert sube["match"] is None

    async def test_already_imported_expense_is_not_offered_as_candidate(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN an expense already linked to a statement document (via a prior import)
        WHEN the statement is parsed again
        THEN the imported row is NOT offered as a reconciliation candidate (ADR-084)
        """
        # GIVEN — import once, which creates EXPENSE rows carrying a statement_document_id.
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        imported = await test_client.post(f"{STATEMENTS}/import", json=_import_body(pdf_base64=encoded))
        assert imported.status_code == status.HTTP_201_CREATED
        _mock_extract_text(monkeypatch, _GALICIA_VISA_TEXT)

        # WHEN — parse the same statement; the just-imported rows match every line on
        # amount/date/name, so only the manual-expense filter keeps them out.
        data = (await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())).json()["data"]

        # THEN — no line is flagged: the only same-amount rows are already imported.
        assert all(line["match"] is None for line in data["lines"])


class TestImportResolution:
    """POST /statements/import resolves each confirmed line import / merge / keep_both (ADR-085)."""

    async def test_merge_enriches_the_existing_expense_without_duplicating(self, test_client: httpx.AsyncClient):
        """
        GIVEN a manual expense and an import line resolving to merge against it
        WHEN the statement is imported
        THEN mergedCount is 1, createdCount excludes it, no duplicate row is created,
             and the existing row gains the card and category from the statement line
        """
        # GIVEN — a manual expense with NO bank and NO category to enrich.
        match_id = await _create_manual_expense(
            test_client,
            name="Express Cordoba dinner",
            amount="10180.00",
            occurred_on="2026-05-08",
        )
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                _line(
                    occurred_on="2026-05-08",
                    name="Express Av Cordoba 3721",
                    amount="10180.00",
                    category="Food",
                    bank="Galicia VISA ·5771",
                    resolution="merge",
                    match_transaction_id=match_id,
                )
            ],
        )

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN — one merge, no creation.
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()["data"]
        assert data["mergedCount"] == 1
        assert data["createdCount"] == 0
        assert data["mergedTransactionIds"] == [match_id]
        assert data["createdTransactionIds"] == []

        # THEN — no duplicate: still exactly one row with that name, enriched in place.
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        rows = [row for row in listed if row["name"] == "Express Cordoba dinner"]
        assert len(rows) == 1
        enriched = rows[0]
        assert enriched["id"] == match_id  # same identity, not a new row.
        assert enriched["bank"] == "Galicia VISA ·5771"  # card set from the statement line.
        assert enriched["category"] == "Food"  # filled because it was empty.

    async def test_merge_links_the_statement_document_so_a_reparse_no_longer_flags_it(
        self, test_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN a manual expense merged into a statement import
        WHEN the same statement is parsed again
        THEN the merged row is now an imported row and is no longer offered as a candidate
             (proving the merge linked it to the statement document — ADR-084, ADR-085)
        """
        # GIVEN
        match_id = await _create_manual_expense(
            test_client,
            name="Express Cordoba dinner",
            amount="10180.00",
            occurred_on="2026-05-08",
        )
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        merged = await test_client.post(
            f"{STATEMENTS}/import",
            json=_import_body(
                pdf_base64=encoded,
                lines=[
                    _line(
                        occurred_on="2026-05-08",
                        name="Express Av Cordoba 3721",
                        amount="10180.00",
                        bank="Galicia VISA ·5771",
                        resolution="merge",
                        match_transaction_id=match_id,
                    )
                ],
            ),
        )
        assert merged.status_code == status.HTTP_201_CREATED
        _mock_extract_text(monkeypatch, _GALICIA_VISA_TEXT)

        # WHEN — re-parse the statement.
        data = (await test_client.post(f"{STATEMENTS}/parse", files=_pdf_upload())).json()["data"]

        # THEN — the merged row links the document now, so it is no longer a candidate.
        express = next(line for line in data["lines"] if line["name"] == "Express Av Cordoba 3721")
        assert express["match"] is None

    async def test_keep_both_creates_a_new_row_and_leaves_the_existing_one(self, test_client: httpx.AsyncClient):
        """
        GIVEN a manual expense and an import line resolving to keep_both
        WHEN the statement is imported
        THEN a NEW transaction is created and the existing one remains (two rows)
        """
        # GIVEN
        match_id = await _create_manual_expense(
            test_client,
            name="Express Cordoba dinner",
            amount="10180.00",
            occurred_on="2026-05-08",
        )
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                _line(
                    occurred_on="2026-05-08",
                    name="Express Av Cordoba 3721",
                    amount="10180.00",
                    bank="Galicia VISA ·5771",
                    resolution="keep_both",
                )
            ],
        )

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN — a new row created, none merged.
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()["data"]
        assert data["createdCount"] == 1
        assert data["mergedCount"] == 0

        # THEN — both the manual row and the new imported row exist.
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        ids = {row["id"] for row in listed}
        assert match_id in ids  # the manual expense survived untouched.
        assert data["createdTransactionIds"][0] in ids  # the new statement row.
        assert len([row for row in listed if row["amountNum"] == "10180.00"]) == 2

    async def test_merge_without_match_id_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN an import line resolving to merge but omitting matchTransactionId
        WHEN the statement is imported
        THEN boundary validation returns 422 (ADR-085) and nothing is created
        """
        # GIVEN
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                _line(occurred_on="2026-05-08", name="Express Av Cordoba 3721", amount="10180.00", resolution="merge")
            ],
        )

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert (await test_client.get(TRANSACTIONS)).json()["data"] == []

    async def test_merge_with_absent_match_id_returns_409(self, test_client: httpx.AsyncClient):
        """
        GIVEN an import line resolving to merge against a random/absent transaction id
        WHEN the statement is imported
        THEN it returns 409 (the merge target does not exist — ADR-085)
        """
        # GIVEN
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                _line(
                    occurred_on="2026-05-08",
                    name="Express Av Cordoba 3721",
                    amount="10180.00",
                    resolution="merge",
                    match_transaction_id=str(uuid4()),
                )
            ],
        )

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN
        assert response.status_code == status.HTTP_409_CONFLICT

    async def test_mixed_batch_resolves_each_line_and_persists_atomically(self, test_client: httpx.AsyncClient):
        """
        GIVEN one import, one merge and one keep_both line in a single request
        WHEN the statement is imported
        THEN the counts split correctly and every resolution is persisted
        """
        # GIVEN — a manual expense to merge into, plus a manual expense to keep beside.
        merge_id = await _create_manual_expense(
            test_client,
            name="Express Cordoba dinner",
            amount="10180.00",
            occurred_on="2026-05-08",
        )
        keep_id = await _create_manual_expense(
            test_client,
            name="MERPAGO PASSLINE",
            amount="3641.66",
            occurred_on="2026-03-20",
        )
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        body = _import_body(
            pdf_base64=encoded,
            lines=[
                # plain import (no match) — a new row.
                _line(occurred_on="2026-05-14", name="SUBE VIAJES - BUSES", amount="700.00", bank="Galicia VISA ·5771"),
                # merge — enriches the existing manual expense.
                _line(
                    occurred_on="2026-05-08",
                    name="Express Av Cordoba 3721",
                    amount="10180.00",
                    bank="Galicia VISA ·5771",
                    resolution="merge",
                    match_transaction_id=merge_id,
                ),
                # keep_both — a new row alongside the existing manual expense.
                _line(
                    occurred_on="2026-03-20",
                    name="MERPAGO*PASSLINE",
                    amount="3641.66",
                    bank="Galicia VISA ·5771",
                    resolution="keep_both",
                ),
            ],
        )

        # WHEN
        response = await test_client.post(f"{STATEMENTS}/import", json=body)

        # THEN — counts split: two created (import + keep_both), one merged.
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()["data"]
        assert data["createdCount"] == 2
        assert data["mergedCount"] == 1
        assert data["mergedTransactionIds"] == [merge_id]

        # THEN — atomic persistence: both manual rows survive, two new rows exist
        # (2 seeded + 2 created = 4 total), the merged one enriched in place.
        listed = (await test_client.get(TRANSACTIONS)).json()["data"]
        assert len(listed) == 4
        ids = {row["id"] for row in listed}
        assert merge_id in ids
        assert keep_id in ids
        for created_id in data["createdTransactionIds"]:
            assert created_id in ids
        merged_row = next(row for row in listed if row["id"] == merge_id)
        assert merged_row["bank"] == "Galicia VISA ·5771"


class TestDownloadStatementDocument:
    """GET /statements/{id}/document streams or 404s the stored PDF."""

    async def test_returns_bytes_inline_after_import(self, test_client: httpx.AsyncClient):
        """
        GIVEN a really-imported statement document
        WHEN its document is downloaded by the shared statement document id
        THEN it returns 200 with the original bytes and an inline content-disposition
        """
        # GIVEN
        encoded = base64.b64encode(_PDF_BYTES).decode("ascii")
        result = (await test_client.post(f"{STATEMENTS}/import", json=_import_body(pdf_base64=encoded))).json()["data"]
        statement_document_id = result["statementDocumentId"]

        # WHEN
        response = await test_client.get(f"{STATEMENTS}/{statement_document_id}/document")

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.content == _PDF_BYTES
        assert response.headers["content-type"] == "application/pdf"
        assert "inline" in response.headers["content-disposition"]
        assert statement_document_id in response.headers["content-disposition"]

    async def test_returns_404_when_absent(self, test_client: httpx.AsyncClient):
        """
        GIVEN no stored statement document for an id
        WHEN that id's document is downloaded
        THEN it returns 404
        """
        # WHEN
        response = await test_client.get(f"{STATEMENTS}/{uuid4()}/document")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
