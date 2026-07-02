"""Route tests for the reports entrypoint (ADR-163, ADR-164, ADR-165).

The net-worth-history route is driven with the query-side reader **mocked** to a
:class:`FakeReportsReader` (ADR-032): it asserts the HTTP contract — the ``{data}``
envelope, camelCase fields, the months clamp param and owner scoping — not the
cumulative SQL (the integration tier proves that).

The CSV export routes drive the **REAL** container on in-memory async SQLite
(ADR-019) so transactions are genuinely persisted and the reader / summaries
aggregation run for real: they assert the ``text/csv`` content type, the
``Content-Disposition`` attachment, a parsed data row, and owner scoping (a second
user never sees the first's rows). Auth is the stub user by default (ADR-098); the
cross-tenant checks use the second stub on a separate app over the SAME container.
"""

from __future__ import annotations

import csv
import io
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.entrypoint.dependencies import get_reports_reader
from margen_api.service_layer.reports_read_models import NetWorthHistory, NetWorthHistoryPoint
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B, STUB_USER_ID
from tests.fakes.persistence import FakeReportsReader

REPORTS = "/api/v1/reports"
NET_WORTH_HISTORY = f"{REPORTS}/net-worth-history"
EXPORT_TRANSACTIONS = f"{REPORTS}/export/transactions"
EXPORT_SUMMARY = f"{REPORTS}/export/summary"
TRANSACTIONS = "/api/v1/transactions"
INSTITUTIONS = "/api/v1/institutions"
ACCOUNTS = "/api/v1/accounts"
TRANSFERS = "/api/v1/transfers"


def _current_month_key() -> str:
    """Return the current server month as ``YYYY-MM`` (matches the reader's anchor)."""
    today = datetime.now(UTC).date()
    return f"{today.year:04d}-{today.month:02d}"


def _today_iso() -> str:
    """Return today's date as an ISO string for a movement in the current month."""
    return date.today().isoformat()


def _history() -> NetWorthHistory:
    """Build a canned two-month net-worth history covering both currencies."""
    return NetWorthHistory(
        months=[
            NetWorthHistoryPoint(month="2026-05", ars_total=Decimal("100000.00"), usd_total=Decimal("0.00")),
            NetWorthHistoryPoint(month="2026-06", ars_total=Decimal("98000.00"), usd_total=Decimal("50.00")),
        ]
    )


def _rows(csv_text: str) -> list[list[str]]:
    """Parse CSV text back into string rows for assertions."""
    return list(csv.reader(io.StringIO(csv_text)))


class TestNetWorthHistory:
    """GET /reports/net-worth-history returns the {data} envelope (ADR-164)."""

    @pytest.fixture(name="reader")
    def fixture_reader(self) -> FakeReportsReader:
        """Provide a fake reports reader returning a canned history."""
        return FakeReportsReader(_history())

    @pytest.fixture(name="client")
    async def fixture_client(self, reader: FakeReportsReader) -> AsyncIterator[httpx.AsyncClient]:
        """Build an ASGI client whose reports reader dependency is mocked."""
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
        app = get_application(container)
        app.dependency_overrides[get_reports_reader] = lambda: reader
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    async def test_returns_envelope_with_native_subtotals(self, client: httpx.AsyncClient, reader: FakeReportsReader):
        """
        GIVEN a mocked reader returning a canned history
        WHEN the net-worth-history endpoint is requested
        THEN it returns 200 with the {data} envelope, camelCase native subtotals,
             oldest-first, scoped to the authenticated owner (ADR-030, ADR-164)
        """
        # WHEN
        response = await client.get(NET_WORTH_HISTORY, params={"months": 12})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        months = response.json()["data"]["months"]
        assert [point["month"] for point in months] == ["2026-05", "2026-06"]
        # camelCase native subtotals; no server-side conversion.
        assert months[1] == {"month": "2026-06", "arsTotal": "98000.00", "usdTotal": "50.00"}
        # The router forwards the clamp param and scopes to the owner (ADR-108).
        assert reader.requested_months == 12
        assert reader.requested_user_id == STUB_USER_ID

    async def test_defaults_months_when_omitted(self, client: httpx.AsyncClient, reader: FakeReportsReader):
        """
        GIVEN no months query param
        WHEN the endpoint is requested
        THEN it returns 200 and the reader is asked for the default 12-month window
        """
        # WHEN
        response = await client.get(NET_WORTH_HISTORY)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert reader.requested_months == 12

    @pytest.mark.parametrize("bad_months", [0, -1, 9999])
    async def test_out_of_range_months_returns_422(self, client: httpx.AsyncClient, bad_months: int):
        """
        GIVEN a months param outside the supported range
        WHEN the endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(NET_WORTH_HISTORY, params={"months": bad_months})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestNetWorthHistoryDbBacked:
    """The REAL reports reader runs its cumulative SQL on the in-memory tier (ADR-164).

    Drives the endpoint through the real container (no reader override) so the
    ``SqlAlchemyReportsReader`` SQL — opening totals, signed transaction deltas, the
    net transfer flow — executes end to end. Movements are placed in the CURRENT
    month (the reader anchors its window at ``datetime.now``) so the newest point
    reflects them regardless of the run date.
    """

    async def _institution(self, client: httpx.AsyncClient) -> str:
        """Create an institution and return its id."""
        response = await client.post(INSTITUTIONS, json={"name": "Galicia", "type": "bank"})
        assert response.status_code == status.HTTP_201_CREATED, response.text
        return response.json()["data"]["id"]

    async def _account(self, client: httpx.AsyncClient, institution_id: str, **body: object) -> str:
        """Create an account under an institution and return its id."""
        payload: dict[str, object] = {"institutionId": institution_id, "currency": "ARS", "openingBalance": "0"}
        payload.update(body)
        response = await client.post(ACCOUNTS, json=payload)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        return response.json()["data"]["id"]

    async def test_empty_owner_returns_zero_series(self, test_client: httpx.AsyncClient):
        """
        GIVEN an owner with no accounts
        WHEN net-worth history is read through the real reader
        THEN every month is present with zero native subtotals (ADR-164)
        """
        # WHEN
        response = await test_client.get(NET_WORTH_HISTORY, params={"months": 3})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        months = response.json()["data"]["months"]
        assert len(months) == 3
        assert all(point["arsTotal"] == "0.00" and point["usdTotal"] == "0.00" for point in months)
        assert months[-1]["month"] == _current_month_key()

    async def test_current_month_reflects_opening_deltas_and_transfer_flow(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS account (opening 10000) with an income, a USD account with a
              USD income, and a same-currency transfer to a second ARS account
        WHEN net-worth history is read through the real reader
        THEN the current month's native subtotals reconcile opening + signed deltas
             + net transfer flow per currency (ADR-122, ADR-135, ADR-164)
        """
        # GIVEN
        institution = await self._institution(test_client)
        ars = await self._account(test_client, institution, currency="ARS", openingBalance="10000")
        ars_two = await self._account(test_client, institution, currency="ARS", openingBalance="0")
        usd = await self._account(test_client, institution, currency="USD", openingBalance="0")
        today = _today_iso()
        # +5000 ARS income into the first ARS account.
        await test_client.post(
            TRANSACTIONS,
            json={"occurredOn": today, "name": "Salary", "kind": "income", "amountNum": "5000", "accountId": ars},
        )
        # +50 USD income (native snapshot) into the USD account.
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": today,
                "name": "Deel payout",
                "kind": "income",
                "amountNum": "50",
                "currency": "USD",
                "usd": "50",
                "rate": "1000",
                "accountId": usd,
            },
        )
        # A same-currency ARS transfer: nets to zero across the two ARS accounts.
        transfer = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": ars,
                "toAccountId": ars_two,
                "amountOut": "1000",
                "amountIn": "1000",
                "occurredOn": today,
            },
        )
        assert transfer.status_code == status.HTTP_201_CREATED, transfer.text

        # WHEN
        response = await test_client.get(NET_WORTH_HISTORY, params={"months": 2})

        # THEN — current month: ARS 10000 + 5000 income + (1000 - 1000) transfer = 15000; USD = 50.
        assert response.status_code == status.HTTP_200_OK
        current = response.json()["data"]["months"][-1]
        assert current["month"] == _current_month_key()
        assert current["arsTotal"] == "15000.00"
        assert current["usdTotal"] == "50.00"

    async def test_pre_window_movement_folds_into_the_opening_cumulative(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income dated well before the requested window's first month
        WHEN net-worth history is read for a short window
        THEN that pre-window balance is carried into the first point, not dropped
             (ADR-164) — the whole series reflects it
        """
        # GIVEN — an account plus an income dated years before the 2-month window.
        institution = await self._institution(test_client)
        account = await self._account(test_client, institution, currency="ARS", openingBalance="0")
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": "2020-01-15",
                "name": "Old income",
                "kind": "income",
                "amountNum": "7000",
                "accountId": account,
            },
        )

        # WHEN
        response = await test_client.get(NET_WORTH_HISTORY, params={"months": 2})

        # THEN — the carried-in 7000 is present from the first point onward.
        months = response.json()["data"]["months"]
        assert months[0]["arsTotal"] == "7000.00"
        assert months[-1]["arsTotal"] == "7000.00"

    async def test_user_b_history_excludes_user_a_balances(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A holds an account with a balance
        WHEN user B reads net-worth history
        THEN B's series is all-zero — A's balances never leak (ADR-108, ADR-131)
        """
        # GIVEN — user A creates an account with an opening balance.
        institution = await self._institution(test_client)
        await self._account(test_client, institution, currency="ARS", openingBalance="99999")

        # WHEN / THEN — user B sees none of A's balances.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.get(NET_WORTH_HISTORY, params={"months": 2})
            assert response.status_code == status.HTTP_200_OK
            months = response.json()["data"]["months"]
            assert all(point["arsTotal"] == "0.00" and point["usdTotal"] == "0.00" for point in months)


class TestExportTransactions:
    """GET /reports/export/transactions streams a text/csv attachment (ADR-165)."""

    async def _post_transaction(self, client: httpx.AsyncClient, **body: object) -> None:
        """POST a transaction, asserting 201."""
        defaults: dict[str, object] = {"kind": "expense", "amountNum": "250"}
        defaults.update(body)
        response = await client.post(TRANSACTIONS, json=defaults)
        assert response.status_code == status.HTTP_201_CREATED, response.text

    async def test_returns_csv_attachment_with_a_parsed_row(self, test_client: httpx.AsyncClient):
        """
        GIVEN the caller has one transaction
        WHEN the transactions export is requested with no date filter
        THEN it returns 200 text/csv, an attachment disposition and a parsed data row
        """
        # GIVEN
        await self._post_transaction(test_client, occurredOn="2026-06-12", name="Coto", amountNum="250")

        # WHEN
        response = await test_client.get(EXPORT_TRANSACTIONS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.headers["content-type"].startswith("text/csv")
        assert response.headers["content-disposition"] == 'attachment; filename="margen-transactions-all-all.csv"'
        rows = _rows(response.text)
        assert rows[0][:3] == ["id", "occurred_on", "name"]
        assert rows[1][1] == "2026-06-12"
        assert rows[1][2] == "Coto"

    async def test_date_range_filters_rows_and_names_the_file(self, test_client: httpx.AsyncClient):
        """
        GIVEN transactions in May and June
        WHEN the export is requested for a from/to window inside June
        THEN only the June row is exported and the filename encodes the bounds
        """
        # GIVEN
        await self._post_transaction(test_client, occurredOn="2026-05-01", name="May spend")
        await self._post_transaction(test_client, occurredOn="2026-06-15", name="June spend")

        # WHEN — inclusive [2026-06-01, 2026-06-30].
        response = await test_client.get(EXPORT_TRANSACTIONS, params={"from": "2026-06-01", "to": "2026-06-30"})

        # THEN — only June, and the filename carries the applied bounds.
        assert response.status_code == status.HTTP_200_OK
        assert (
            response.headers["content-disposition"]
            == 'attachment; filename="margen-transactions-2026-06-01-2026-06-30.csv"'
        )
        rows = _rows(response.text)
        names = [row[2] for row in rows[1:]]
        assert names == ["June spend"]

    async def test_user_b_export_excludes_user_a_rows(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created a transaction
        WHEN user B exports transactions
        THEN B's CSV is header-only — A's rows never appear (ADR-108, ADR-131)
        """
        # GIVEN — user A (the default stub) creates a transaction.
        await self._post_transaction(test_client, occurredOn="2026-06-12", name="A only")

        # WHEN / THEN — user B exports and sees none of A's rows.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.get(EXPORT_TRANSACTIONS)
            assert response.status_code == status.HTTP_200_OK
            rows = _rows(response.text)
            assert len(rows) == 1  # header only


class TestExportSummary:
    """GET /reports/export/summary streams a category-breakdown CSV (ADR-165, ADR-042)."""

    async def test_returns_csv_attachment_with_category_row(self, test_client: httpx.AsyncClient):
        """
        GIVEN the caller has an expense in a category for a month
        WHEN the summary export is requested for that month
        THEN it returns 200 text/csv, an attachment disposition and the category row
        """
        # GIVEN
        response = await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": "2026-06-12",
                "name": "Coto",
                "kind": "expense",
                "amountNum": "250",
                "category": "Food",
            },
        )
        assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        response = await test_client.get(EXPORT_SUMMARY, params={"month": "2026-06"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.headers["content-type"].startswith("text/csv")
        assert response.headers["content-disposition"] == 'attachment; filename="margen-summary-2026-06.csv"'
        rows = _rows(response.text)
        assert rows[0] == ["category", "amount", "share_pct", "delta_pct"]
        by_category = {row[0]: row for row in rows[1:]}
        assert by_category["Food"][1] == "250.00"

    async def test_defaults_to_current_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN no month query param
        WHEN the summary export is requested
        THEN it returns 200 with a text/csv attachment for the current server month
        """
        # WHEN
        response = await test_client.get(EXPORT_SUMMARY)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.headers["content-type"].startswith("text/csv")
        assert response.headers["content-disposition"].startswith('attachment; filename="margen-summary-')

    async def test_malformed_month_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a malformed month query param
        WHEN the summary export is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await test_client.get(EXPORT_SUMMARY, params={"month": "2026-13"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
