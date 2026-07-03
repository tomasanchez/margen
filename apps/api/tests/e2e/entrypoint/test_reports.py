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
from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.dependencies import get_reports_reader
from margen_api.service_layer.reports_overview import add_months
from margen_api.service_layer.reports_overview_read_models import (
    CashFlowPoint,
    CategoryTrend,
    FxSummary,
    RateSeriesPoint,
    ReportsKpi,
    ReportsKpis,
    ReportsOverview,
)
from margen_api.service_layer.reports_read_models import NetWorthHistory, NetWorthHistoryPoint
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B, STUB_USER_ID
from tests.fakes.persistence import FakeReportsReader

REPORTS = "/api/v1/reports"
OVERVIEW = f"{REPORTS}/overview"
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


def _overview() -> ReportsOverview:
    """Build a canned overview exercising every panel and the unconverted caveat."""
    return ReportsOverview(
        range="6M",
        currency="USD",
        kpis=ReportsKpis(
            current=ReportsKpi(
                income=Decimal("1000.00"),
                expenses=Decimal("400.00"),
                net_saved=Decimal("600.00"),
                savings_rate=Decimal("60"),
            ),
            previous=ReportsKpi(
                income=Decimal("800.00"),
                expenses=Decimal("500.00"),
                net_saved=Decimal("300.00"),
                savings_rate=Decimal("37.5"),
            ),
        ),
        cash_flow=[CashFlowPoint(month="2026-06", income=Decimal("1000.00"), expenses=Decimal("400.00"))],
        category_trends=[
            CategoryTrend(
                category="Food",
                total=Decimal("400.00"),
                share=Decimal("100"),
                series=[Decimal("0.00"), Decimal("400.00")],
                delta_pct=Decimal("-20"),
            )
        ],
        fx_summary=FxSummary(
            avg_mep=Decimal("1000.000000"),
            usd_invoiced=Decimal("1000.00"),
            rate_series=[RateSeriesPoint(month="2026-06", rate=Decimal("1000.000000"))],
        ),
        unconverted=2,
    )


class TestReportsOverview:
    """GET /reports/overview returns the {data} envelope for the redesign (ADR-167)."""

    @pytest.fixture(name="reader")
    def fixture_reader(self) -> FakeReportsReader:
        """Provide a fake reports reader returning a canned overview."""
        return FakeReportsReader(_history(), overview=_overview())

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

    async def test_returns_envelope_with_every_panel(self, client: httpx.AsyncClient, reader: FakeReportsReader):
        """
        GIVEN a mocked reader returning a canned overview
        WHEN the overview endpoint is requested for the 6M USD window
        THEN it returns 200 with the {data} envelope, camelCase panels, and forwards
             the range/currency scoped to the authenticated owner (ADR-030, ADR-167)
        """
        # WHEN
        response = await client.get(OVERVIEW, params={"range": "6M", "currency": "USD"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["range"] == "6M"
        assert data["currency"] == "USD"
        assert data["unconverted"] == 2
        # KPI strip carries current + previous for the vs-previous delta (camelCase).
        assert data["kpis"]["current"] == {
            "income": "1000.00",
            "expenses": "400.00",
            "netSaved": "600.00",
            "savingsRate": "60",
        }
        assert data["kpis"]["previous"]["netSaved"] == "300.00"
        # cashFlow, categoryTrends (with sparkline series + deltaPct), fxSummary.
        assert data["cashFlow"][0] == {"month": "2026-06", "income": "1000.00", "expenses": "400.00"}
        trend = data["categoryTrends"][0]
        assert trend["category"] == "Food"
        assert trend["series"] == ["0.00", "400.00"]
        assert trend["deltaPct"] == "-20"
        assert data["fxSummary"]["avgMep"] == "1000.000000"
        assert data["fxSummary"]["usdInvoiced"] == "1000.00"
        assert data["fxSummary"]["rateSeries"][0] == {"month": "2026-06", "rate": "1000.000000"}
        # The router forwards the range/currency and scopes to the owner (ADR-108).
        assert reader.requested_range == "6M"
        assert reader.requested_currency == Currency.USD
        assert reader.requested_user_id == STUB_USER_ID

    async def test_defaults_to_six_months_ars(self, client: httpx.AsyncClient, reader: FakeReportsReader):
        """
        GIVEN no range or currency query params
        WHEN the overview endpoint is requested
        THEN it returns 200 and the reader is asked for the default 6M ARS window
        """
        # WHEN
        response = await client.get(OVERVIEW)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert reader.requested_range == "6M"
        assert reader.requested_currency == Currency.ARS

    @pytest.mark.parametrize("bad_param", [{"range": "2Y"}, {"currency": "EUR"}])
    async def test_out_of_set_params_return_422(self, client: httpx.AsyncClient, bad_param: dict[str, str]):
        """
        GIVEN an out-of-set range or currency
        WHEN the overview endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(OVERVIEW, params=bad_param)

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestReportsOverviewDbBacked:
    """The REAL reports reader runs its range SQL on the in-memory tier (ADR-167, ADR-168).

    Drives the endpoint through the real container (no reader override) so the
    ``SqlAlchemyReportsReader`` range aggregations execute end to end. Movements are
    placed in the CURRENT month (the reader anchors its window at ``datetime.now``)
    so the newest cash-flow point reflects them regardless of the run date.
    """

    async def _post(self, client: httpx.AsyncClient, **body: object) -> str:
        """POST a transaction dated today, asserting 201, and return its id."""
        payload: dict[str, object] = {"occurredOn": _today_iso(), "name": "Movement"}
        payload.update(body)
        response = await client.post(TRANSACTIONS, json=payload)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        return response.json()["data"]["id"]

    async def test_ars_overview_reconciles_kpis_and_category(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS income and an ARS expense in a category this month
        WHEN the ARS overview is read through the real reader
        THEN the current KPIs and the category trend reflect the ARS amounts and
             unconverted is 0 (ADR-167, ADR-168)
        """
        # GIVEN
        await self._post(test_client, kind="income", amountNum="1000", name="Salary")
        await self._post(test_client, kind="expense", amountNum="400", category="Food")

        # WHEN
        response = await test_client.get(OVERVIEW, params={"range": "3M", "currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currency"] == "ARS"
        assert data["unconverted"] == 0
        assert data["kpis"]["current"]["income"] == "1000.00"
        assert data["kpis"]["current"]["expenses"] == "400.00"
        assert data["kpis"]["current"]["netSaved"] == "600.00"
        current_flow = data["cashFlow"][-1]
        assert current_flow["month"] == _current_month_key()
        assert current_flow["income"] == "1000.00"
        food = next(trend for trend in data["categoryTrends"] if trend["category"] == "Food")
        assert food["total"] == "400.00"

    async def test_usd_overview_sums_snapshot_and_counts_unconverted(self, test_client: httpx.AsyncClient):
        """
        GIVEN a USD invoice with a snapshot and an ARS expense WITHOUT a USD snapshot
        WHEN the USD overview is read through the real reader
        THEN income sums the usd_amount snapshot, the snapshotless row is excluded and
             surfaced in unconverted, and the FX summary carries the captured rate
             (ADR-152, ADR-167, ADR-168)
        """
        # GIVEN — a USD invoice (snapshot usd=1000 @ rate 1000), a USD expense with a
        # snapshot (usd=200 @ rate 1000) in a category, and an ARS expense (no snapshot).
        await self._post(
            test_client,
            kind="invoice",
            amountNum="1000000",
            currency="USD",
            usd="1000",
            rate="1000",
            name="Client invoice",
        )
        await self._post(
            test_client,
            kind="expense",
            amountNum="200000",
            currency="USD",
            usd="200",
            rate="1000",
            category="Food",
            name="USD fee",
        )
        await self._post(test_client, kind="expense", amountNum="400", category="Transport")

        # WHEN
        response = await test_client.get(OVERVIEW, params={"range": "3M", "currency": "USD"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currency"] == "USD"
        # income sums the USD snapshot; the ARS expense has no usd_amount -> excluded + counted.
        assert data["kpis"]["current"]["income"] == "1000.00"
        assert data["kpis"]["current"]["expenses"] == "200.00"
        assert data["unconverted"] == 1
        # the USD expense forms a Food category trend on the snapshot column.
        food = next(trend for trend in data["categoryTrends"] if trend["category"] == "Food")
        assert food["total"] == "200.00"
        assert data["fxSummary"]["usdInvoiced"] == "1000.00"
        assert data["fxSummary"]["avgMep"] == "1000.000000"

    async def test_unconverted_counts_only_snapshotless_expenses_not_income(self, test_client: httpx.AsyncClient):
        """
        GIVEN a snapshot-less ARS income and a snapshot-less ARS expense this month
        WHEN the USD overview is read
        THEN only the expense is counted as unconverted — ARS income has no FX
             snapshot by design and must never be backfilled (ADR-156, ADR-150, ADR-168)
        """
        # GIVEN — an ARS income and an ARS expense, neither carrying a USD snapshot.
        await self._post(test_client, kind="income", amountNum="1000", name="Salary")
        await self._post(test_client, kind="expense", amountNum="400", category="Food")

        # WHEN
        response = await test_client.get(OVERVIEW, params={"range": "3M", "currency": "USD"})

        # THEN — the snapshot-less expense counts; the snapshot-less income does NOT.
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currency"] == "USD"
        assert data["unconverted"] == 1

    async def test_ars_over_refunded_month_floors_out_of_trends(self, test_client: httpx.AsyncClient):
        """
        GIVEN a current month whose ONLY expense is fully over-refunded by a linked
              reimbursement, plus a sibling expense in a prior window month
        WHEN the ARS overview is read
        THEN the over-refunded category floors at zero and its whole month drops out of
             the trends (ADR-160, ADR-162), while the prior month's category still shows
        """
        # GIVEN — the current month's only expense (Food 1000) is over-refunded by 1500,
        # so the entire month nets to nothing; a prior-window Transport 300 still stands.
        expense_id = await self._post(test_client, kind="expense", amountNum="1000", category="Food")
        await self._post(
            test_client,
            kind="reimbursement",
            amountNum="1500",
            offsetsTransactionId=expense_id,
            name="Over refund",
        )
        prior_month_day = add_months(date.today().replace(day=1), -1).replace(day=15).isoformat()
        response = await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": prior_month_day,
                "name": "Bus",
                "kind": "expense",
                "amountNum": "300",
                "category": "Transport",
            },
        )
        assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        response = await test_client.get(OVERVIEW, params={"range": "3M", "currency": "ARS"})

        # THEN — the fully over-refunded current month drops out; only Transport remains.
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        categories = [trend["category"] for trend in data["categoryTrends"]]
        assert "Food" not in categories
        assert categories == ["Transport"]

    async def test_user_b_overview_excludes_user_a_data(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A has income and expenses this month
        WHEN user B reads the overview
        THEN B's KPIs are all zero — A's data never leaks (ADR-108, ADR-131)
        """
        # GIVEN — user A creates movements.
        await self._post(test_client, kind="income", amountNum="5000", name="A income")
        await self._post(test_client, kind="expense", amountNum="900", category="Food")

        # WHEN / THEN — user B sees none of A's data.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.get(OVERVIEW, params={"range": "3M", "currency": "ARS"})
            assert response.status_code == status.HTTP_200_OK
            data = response.json()["data"]
            assert data["kpis"]["current"]["income"] == "0.00"
            assert data["kpis"]["current"]["expenses"] == "0.00"
            assert data["categoryTrends"] == []


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
