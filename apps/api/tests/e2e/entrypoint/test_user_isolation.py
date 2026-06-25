"""Consolidated per-user data isolation across every owned resource (ADR-113).

This is the single source of truth for the per-user isolation invariant. The
per-domain e2e modules (#30..#34) each added ad-hoc isolation checks; this module
proves the SAME invariant in one place across ALL owned resources at once, driving
the **REAL** application container on **in-memory async SQLite** (ADR-019/032) so
user A's rows are genuinely persisted and user B reads them through the real
readers — not a mocked port.

User A is the default stub (``STUB_USER_ID``); user B is the second stub
(``STUB_USER_ID_B``) authenticated on a separate app over the SAME container via
the shared ``client_for_user`` factory (``tests/conftest.py``). The invariant
proven, per ADR-107/108/110/111/112:

* transactions — B's list excludes A's rows; B GET/PATCH/DELETE of A's id → 404,
* documents — B GET of A's invoice and statement document ids → 404 (no bytes),
* summaries + insights — B's month views reflect only B's data (zero when empty),
* monotributo — B's standing is independent of A's used amount,
* settings — B gets their own defaults and B's PATCH never touches A's row.

The only thing mocked is the native PyMuPDF text boundary for the statement parse
(``statement_parser.extract_text``), per ADR-082 — no native stack on the gate.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from fastapi import status

from margen_api.bootstrap import ApplicationContainer
from margen_api.entrypoint.dependencies import AuthUserModel
from margen_api.service_layer import statement_parser
from tests.conftest import STUB_AUTH_USER_B

TRANSACTIONS = "/api/v1/transactions"
INVOICES = "/api/v1/invoices"
STATEMENTS = "/api/v1/statements"
SUMMARIES = "/api/v1/summaries"
INSIGHTS = "/api/v1/insights"
MONOTRIBUTO = "/api/v1/monotributo"
SETTINGS = "/api/v1/settings"

# Minimal valid %PDF-prefixed bytes: the upload boundary only checks the magic
# header, and the statement parse mocks ``extract_text`` so no real decode runs.
_PDF_BYTES = b"%PDF-1.4 fake document body"

# Canonical SANITIZED Galicia VISA vertical-token text (mirrors test_statements):
# a fake-name/account statement the real parser fingerprints, with one purchase.
_GALICIA_VISA_TEXT = """\
 Tarjeta Crédito VISA
CUIT Banco: 30-50000173-5
  Resumen N° VI00000000069436867
TARJETA 5771 Total Consumos de JUAN PEREZ
DETALLE DEL CONSUMO
14-05-26
K
SUBE VIAJES - BUSES
501892
700,00
TARJETA 5771 Total Consumos de JUAN PEREZ
TOTAL A PAGAR
700,00
"""


def _invoice_create_body() -> dict:
    """Build a create body for user A carrying a base64 invoice PDF attachment."""
    return {
        "occurredOn": "2026-06-12",
        "name": "Acme SRL",
        "kind": "invoice",
        "amountNum": "150000.50",
        "currency": "ARS",
        "countsTowardMonotributo": True,
        "document": {
            "pdfBase64": base64.b64encode(_PDF_BYTES).decode("ascii"),
            "contentType": "application/pdf",
            "extractedText": "Acme SRL invoice",
            "emisorCuit": "20304050607",
            "ptoVta": "5",
            "tipoCmp": "11",
            "nroCmp": "1234",
        },
    }


def _statement_import_body() -> dict:
    """Build a one-line statement import body (echoed document + a single line)."""
    return {
        "document": {
            "pdfBase64": base64.b64encode(_PDF_BYTES).decode("ascii"),
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
            "totalAmount": "700.00",
        },
        "lines": [
            {
                "occurredOn": "2026-06-19",
                "purchaseDate": "2026-05-14",
                "name": "SUBE VIAJES - BUSES",
                "amount": "700.00",
                "currency": "ARS",
                "category": "Transport",
                "bank": "Galicia VISA ·5771",
            }
        ],
    }


def _current_month() -> str:
    """Return the current server month as ``YYYY-MM`` (the default month view)."""
    today = datetime.now(UTC).date()
    return f"{today.year:04d}-{today.month:02d}"


class TestTransactionIsolation:
    """User B never sees or mutates user A's transactions (ADR-108, ADR-111)."""

    async def test_b_cannot_see_or_mutate_a_transactions(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A has created an expense transaction
        WHEN user B (a separate identity over the same database) lists and then
             GET/PATCH/DELETEs A's transaction by id
        THEN B's list excludes A's row and every by-id access returns 404 — the row
             is never leaked nor mutated (ADR-111)
        """
        # GIVEN — user A creates a transaction in the shared database.
        created = await test_client.post(
            TRANSACTIONS,
            json={"occurredOn": "2026-06-12", "name": "A's rent", "kind": "expense", "amountNum": "1000.00"},
        )
        assert created.status_code == status.HTTP_201_CREATED
        a_id = created.json()["data"]["id"]

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # THEN — B's list is empty: A's row is invisible.
            listed = (await client_b.get(TRANSACTIONS)).json()["data"]
            assert listed == []

            # THEN — every by-id access to A's row is a 404 for B (existence hidden).
            assert (await client_b.get(f"{TRANSACTIONS}/{a_id}")).status_code == status.HTTP_404_NOT_FOUND
            patched = await client_b.patch(f"{TRANSACTIONS}/{a_id}", json={"name": "hijacked"})
            assert patched.status_code == status.HTTP_404_NOT_FOUND
            assert (await client_b.delete(f"{TRANSACTIONS}/{a_id}")).status_code == status.HTTP_404_NOT_FOUND

        # THEN — A's row is untouched: still present and not renamed/deleted by B.
        a_view = await test_client.get(f"{TRANSACTIONS}/{a_id}")
        assert a_view.status_code == status.HTTP_200_OK
        assert a_view.json()["data"]["name"] == "A's rent"


class TestDocumentIsolation:
    """User B cannot download user A's invoice or statement documents (ADR-111)."""

    async def test_b_cannot_download_a_invoice_document(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A created an invoice transaction with an attached PDF
        WHEN user B downloads it by the transaction id
        THEN it returns 404 and no bytes leak (the foreign id is hidden — ADR-111)
        """
        # GIVEN — user A creates a transaction carrying a stored invoice document.
        created = await test_client.post(TRANSACTIONS, json=_invoice_create_body())
        assert created.status_code == status.HTTP_201_CREATED
        a_id = created.json()["data"]["id"]
        # SANITY — A can download their own document.
        assert (await test_client.get(f"{INVOICES}/{a_id}/document")).status_code == status.HTTP_200_OK

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # WHEN / THEN — B's request for A's document is a 404 with no bytes.
            response = await client_b.get(f"{INVOICES}/{a_id}/document")
            assert response.status_code == status.HTTP_404_NOT_FOUND
            assert response.content != _PDF_BYTES

    async def test_b_cannot_download_a_statement_document(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A imported a statement, so its document is owned by A
        WHEN user B downloads it by the shared statement document id
        THEN it returns 404 and no bytes leak (ADR-111)
        """
        # GIVEN — user A imports a statement, persisting an owned statement document.
        imported = await test_client.post(f"{STATEMENTS}/import", json=_statement_import_body())
        assert imported.status_code == status.HTTP_201_CREATED
        statement_document_id = imported.json()["data"]["statementDocumentId"]
        # SANITY — A can download their own statement document.
        assert (
            await test_client.get(f"{STATEMENTS}/{statement_document_id}/document")
        ).status_code == status.HTTP_200_OK

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # WHEN / THEN — B's request for A's statement document is a 404, no bytes.
            response = await client_b.get(f"{STATEMENTS}/{statement_document_id}/document")
            assert response.status_code == status.HTTP_404_NOT_FOUND
            assert response.content != _PDF_BYTES


class TestSummaryAndInsightIsolation:
    """User B's month views reflect only B's data, never A's (ADR-108)."""

    async def test_b_summaries_and_insights_exclude_a_data(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A has an expense in the current month (so A's summary is non-zero)
        WHEN user B (with no data) reads /summaries and /insights for that month
        THEN B's views are empty/zero — none of A's spend appears (ADR-108)
        """
        # GIVEN — user A spends in the current month.
        month = _current_month()
        first_of_month = f"{month}-12"
        created = await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": first_of_month,
                "name": "A groceries",
                "kind": "expense",
                "amountNum": "5000.00",
                "category": "Food",
            },
        )
        assert created.status_code == status.HTTP_201_CREATED

        # SANITY — A's own summary sees the spend (its category total is non-zero).
        a_summary = (await test_client.get(SUMMARIES, params={"month": month})).json()["data"]
        assert any(Decimal(c["amount"]) != Decimal(0) for c in a_summary["categories"])

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # THEN — B's summary for the same month carries none of A's category spend.
            b_summary = (await client_b.get(SUMMARIES, params={"month": month})).json()["data"]
            assert all(Decimal(c["amount"]) == Decimal(0) for c in b_summary["categories"])

            # THEN — B's insights for the same month carry no recurring/mover facts and
            # zero savings — A's spend never bleeds into B's projection.
            b_insights = (await client_b.get(INSIGHTS, params={"month": month})).json()["data"]
            assert b_insights["topCategoryMover"] is None
            assert b_insights["recurring"] is None
            # savings is a Decimal-string; B saved nothing, so it equals zero
            # numerically (the exact scale may differ, e.g. "0E+28").
            assert Decimal(b_insights["savings"]["amount"]) == Decimal(0)


class TestMonotributoIsolation:
    """User B's Monotributo standing is independent of user A's invoices (ADR-112)."""

    async def test_b_standing_is_independent_of_a(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A booked a large monotributo-counting invoice
        WHEN user B reads their own /monotributo standing
        THEN B's used amount is zero — A's invoice never counts toward B (ADR-112)
        """
        # GIVEN — user A books an invoice that counts toward monotributo.
        created = await test_client.post(TRANSACTIONS, json=_invoice_create_body())
        assert created.status_code == status.HTTP_201_CREATED
        # SANITY — A's own standing reflects the invoice (non-zero used).
        a_standing = (await test_client.get(MONOTRIBUTO)).json()["data"]["current"]
        assert Decimal(a_standing["used"]) != Decimal(0)

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # THEN — B's standing is computed from B's own (empty) invoices: zero used.
            b_standing = (await client_b.get(MONOTRIBUTO)).json()["data"]["current"]
            assert Decimal(b_standing["used"]) == Decimal(0)


class TestSettingsIsolation:
    """Each user owns an independent settings row (ADR-110)."""

    async def test_b_settings_are_independent_and_b_patch_never_touches_a(
        self,
        test_client: httpx.AsyncClient,
        container: ApplicationContainer,
        client_for_user: object,
    ):
        """
        GIVEN user A set their display currency to USD
        WHEN user B reads (getting their own defaults), patches their own category,
             and both read back
        THEN B starts from defaults (not A's USD), B's write lands on B's own row,
             and A's settings are left untouched (ADR-110)
        """
        # GIVEN — user A sets USD on their own settings row.
        await test_client.patch(SETTINGS, json={"preferredDisplayCurrency": "USD"})

        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            # THEN — B does NOT inherit A's USD; B gets their own defaults.
            before = (await client_b.get(SETTINGS)).json()["data"]
            assert before["preferredDisplayCurrency"] == "ARS"

            # WHEN — B patches their own monotributo category.
            await client_b.patch(SETTINGS, json={"monotributoCurrentCategory": "H"})

            # THEN — B's write lands on B's row; A's currency is untouched by B.
            after_b = (await client_b.get(SETTINGS)).json()["data"]
            assert after_b["monotributoCurrentCategory"] == "H"
            assert after_b["preferredDisplayCurrency"] == "ARS"

        # THEN — A's settings still reflect A's own write, never B's.
        after_a = (await test_client.get(SETTINGS)).json()["data"]
        assert after_a["preferredDisplayCurrency"] == "USD"
        assert after_a["monotributoCurrentCategory"] == "C"


@pytest.fixture(autouse=True)
def _mock_statement_extract_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mock the native PyMuPDF text boundary for any statement parse here (ADR-082)."""
    monkeypatch.setattr(statement_parser, "extract_text", lambda _pdf: _GALICIA_VISA_TEXT)


# A throwaway second identity distinct from the module-level stubs, kept to assert
# the ``client_for_user`` factory accepts an arbitrary AuthUserModel (not only the
# two canned stubs) — exercising the factory's user parameter directly.
_AD_HOC_USER = AuthUserModel(
    id="cafe1234-5678-4abc-8def-0011223344ff",
    email="adhoc@example.com",
    claims={"sub": "cafe1234-5678-4abc-8def-0011223344ff"},
)


async def test_client_for_user_factory_authenticates_an_arbitrary_user(
    container: ApplicationContainer,
    client_for_user: object,
) -> None:
    """
    GIVEN the shared client_for_user factory and an arbitrary stub identity
    WHEN a client is built for that user and lists their transactions
    THEN it authenticates (no 401) and returns that user's own empty collection
    """
    async with client_for_user(container, _AD_HOC_USER) as client:  # type: ignore[operator]
        response = await client.get(TRANSACTIONS)
    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == []
