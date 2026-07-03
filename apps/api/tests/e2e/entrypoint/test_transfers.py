"""Route tests for the transfers entrypoint (ADR-135, ADR-130).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so institutions, accounts, transfers and their fee expenses are
genuinely persisted and the account balance / net-worth aggregation unions
transactions + transfers through real SQL — the slice's core behavior (net-zero
same-currency transfer, cross-currency transfer, fees as expense transactions,
isolation from income/expense summaries) is exercised end to end, not mocked. A
transfer moves money between two of the caller's accounts (ADR-135). User A is the
default stub (``STUB_USER_ID``); the cross-tenant checks use the second stub
(``STUB_AUTH_USER_B``) on a separate app over the SAME container via the shared
``client_for_user`` factory.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.domain.models.exceptions import (
    AccountNotFoundError,
    InvalidAmountError,
    SameAccountTransferError,
    TransferNotFoundError,
)
from margen_api.entrypoint.dependencies import get_bus, get_transfer_reader
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B
from tests.fakes.persistence import FakeTransferReader

TRANSFERS = "/api/v1/transfers"
ACCOUNTS = "/api/v1/accounts"
INSTITUTIONS = "/api/v1/institutions"
NET_WORTH = "/api/v1/accounts/net-worth"
TRANSACTIONS = "/api/v1/transactions"
SUMMARIES = "/api/v1/summaries?month=2026-06"
A_DATE = "2026-06-12"


async def _create_institution(client: httpx.AsyncClient, **body: object) -> dict:
    """POST an institution and return the created resource, asserting 201."""
    defaults: dict[str, object] = {"name": "Galicia", "type": "bank"}
    defaults.update(body)
    response = await client.post(INSTITUTIONS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


async def _create_account(client: httpx.AsyncClient, *, currency: str = "ARS", opening_balance: str = "0") -> dict:
    """POST an account under a fresh institution and return the created resource."""
    institution_id = (await _create_institution(client))["id"]
    response = await client.post(
        ACCOUNTS,
        json={"institutionId": institution_id, "currency": currency, "openingBalance": opening_balance},
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


async def _net_worth_by_account(client: httpx.AsyncClient) -> dict[str, dict]:
    """Read net worth and return its per-account breakdown keyed by account id."""
    response = await client.get(NET_WORTH)
    assert response.status_code == status.HTTP_200_OK, response.text
    return {item["id"]: item for item in response.json()["data"]["accounts"]}


class TestTransferCreate:
    """A transfer moves money between two of the caller's accounts (ADR-135)."""

    async def test_same_currency_transfer_is_net_zero_for_net_worth(self, test_client: httpx.AsyncClient):
        """
        GIVEN two ARS accounts opened at 10000 and 0
        WHEN 2500 is transferred between them (no fees)
        THEN the source drops to 7500, the destination rises to 2500, and total net
             worth is conserved (ADR-135)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")

        # WHEN
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "note": "rent top-up",
            },
        )

        # THEN — the created transfer echoes the contract with decimal-string money.
        assert response.status_code == status.HTTP_201_CREATED, response.text
        created = response.json()["data"]
        assert created["fromAccountId"] == source["id"]
        assert created["toAccountId"] == destination["id"]
        assert created["amountOut"] == "2500"
        assert created["amountIn"] == "2500"
        assert created["occurredOn"] == A_DATE
        assert created["note"] == "rent top-up"
        assert created["feeTransactionIds"] == []

        # THEN — balances moved but total net worth is conserved (net-zero).
        balances = await _net_worth_by_account(test_client)
        assert balances[source["id"]]["balance"] == "7500.00"
        assert balances[destination["id"]]["balance"] == "2500.00"
        total = (await test_client.get(NET_WORTH)).json()["data"]["total"]
        assert total == "10000.00"  # unchanged: 7500 + 2500

    async def test_cross_currency_transfer_moves_native_amounts(self, test_client: httpx.AsyncClient):
        """
        GIVEN a USD account at 1000 and an ARS account at 0, and a USD MEP rate
        WHEN 100 USD is sent out and 95000 ARS received
        THEN the USD account drops by 100 USD and the ARS account rises by 95000 ARS,
             each in its native currency (ADR-135, ADR-123)
        """
        # GIVEN — a USD source holding 1000, with a recorded MEP rate so the total converts.
        usd = await _create_account(test_client, currency="USD", opening_balance="1000")
        ars = await _create_account(test_client, currency="ARS", opening_balance="0")
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Seed USD rate",
                "kind": "income",
                "amountNum": "1000",
                "currency": "USD",
                "usd": "1",
                "rate": "1000",
                "accountId": usd["id"],
            },
        )

        # WHEN
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": usd["id"],
                "toAccountId": ars["id"],
                "amountOut": "100",
                "amountIn": "95000",
                "occurredOn": A_DATE,
            },
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED, response.text
        balances = await _net_worth_by_account(test_client)
        # USD account: opening 1000 + the 1 USD seed income - 100 USD out = 901 USD.
        assert balances[usd["id"]]["balance"] == "901.00"
        # ARS account: opening 0 + 95000 ARS in = 95000 ARS.
        assert balances[ars["id"]]["balance"] == "95000.00"

    async def test_fees_create_expense_transactions_in_fees_category(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer with a fee charged to the source account
        WHEN the transfer is created
        THEN a kind=expense transaction in the "Fees" category appears on that
             account, net worth drops by the fee, and the fee id is returned (ADR-135)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")

        # WHEN — transfer 2500 net-zero, plus a 30 ARS fee on the source.
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "fees": [{"accountId": source["id"], "amount": "30", "label": "Transfer fee"}],
            },
        )

        # THEN — the fee id is returned and the fee is a real "Fees" expense.
        assert response.status_code == status.HTTP_201_CREATED, response.text
        fee_ids = response.json()["data"]["feeTransactionIds"]
        assert len(fee_ids) == 1
        transactions = (await test_client.get(TRANSACTIONS)).json()["data"]
        fees = [tx for tx in transactions if tx["id"] == fee_ids[0]]
        assert len(fees) == 1
        assert fees[0]["category"] == "Fees"
        assert fees[0]["name"] == "Transfer fee"
        assert fees[0]["type"] == "expense"
        assert fees[0]["accountId"] == source["id"]

        # THEN — net worth dropped by the fee only (transfer itself is net-zero).
        balances = await _net_worth_by_account(test_client)
        assert balances[source["id"]]["balance"] == "7470.00"  # 10000 - 2500 transfer - 30 fee
        assert balances[destination["id"]]["balance"] == "2500.00"

    async def test_fee_with_fx_snapshot_materializes_usd_amount(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer whose ARS fee carries an FX snapshot (rate + fxSource)
        WHEN the transfer is created
        THEN the fee expense in the transaction list carries a materialized USD value
             (usd = round(amount / rate, 2)) and the persisted rate + source (ADR-148/149)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")

        # WHEN — a 3000 ARS fee stamped with a MEP rate of 1000 ARS per USD.
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "fees": [
                    {
                        "accountId": source["id"],
                        "amount": "3000",
                        "label": "Transfer fee",
                        "rate": "1000",
                        "fxSource": "mep",
                    }
                ],
            },
        )

        # THEN — the fee expense in the list carries the materialized USD snapshot.
        assert response.status_code == status.HTTP_201_CREATED, response.text
        fee_id = response.json()["data"]["feeTransactionIds"][0]
        transactions = (await test_client.get(TRANSACTIONS)).json()["data"]
        fee = next(tx for tx in transactions if tx["id"] == fee_id)
        assert fee["usd"] == "3.00"  # 3000 / 1000
        assert fee["rate"] == "1000.000000"  # NUMERIC(18,6) round-trip (ADR-148)
        assert fee["fxSource"] == "mep"

    async def test_fee_without_fx_snapshot_has_no_usd(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer whose ARS fee carries NO FX snapshot
        WHEN the transfer is created
        THEN the fee expense persists with a null USD value and no crash (tolerant, ADR-031)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")

        # WHEN
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "fees": [{"accountId": source["id"], "amount": "30", "label": "Transfer fee"}],
            },
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED, response.text
        fee_id = response.json()["data"]["feeTransactionIds"][0]
        transactions = (await test_client.get(TRANSACTIONS)).json()["data"]
        fee = next(tx for tx in transactions if tx["id"] == fee_id)
        assert fee["usd"] is None
        assert fee["rate"] is None
        assert fee["fxSource"] is None

    async def test_transfers_do_not_leak_into_income_or_expense_summaries(self, test_client: httpx.AsyncClient):
        """
        GIVEN a same-currency transfer with NO fees between two accounts
        WHEN the month's summary is read
        THEN the transfer contributes nothing to income/expense totals (ADR-135)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")
        await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
            },
        )

        # WHEN
        response = await test_client.get(SUMMARIES)

        # THEN — the transfer left no income/expense rows, so every category is empty.
        assert response.status_code == status.HTTP_200_OK, response.text
        categories = response.json()["data"]["categories"]
        assert all(category["amount"] == "0" for category in categories)


class TestTransferValidation:
    """Domain invariants and ownership surface as the right HTTP status (ADR-031, ADR-130)."""

    async def test_same_account_transfer_is_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer whose source and destination are the same account
        WHEN it is created
        THEN it returns 422 (ADR-031, ADR-135)
        """
        # GIVEN
        account = await _create_account(test_client)

        # WHEN
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": account["id"],
                "toAccountId": account["id"],
                "amountOut": "100",
                "amountIn": "100",
                "occurredOn": A_DATE,
            },
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_unknown_source_account_is_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer referencing a source account that does not exist
        WHEN it is created
        THEN it returns 404 (ADR-130, ADR-111)
        """
        # GIVEN
        destination = await _create_account(test_client)

        # WHEN
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": str(uuid4()),
                "toAccountId": destination["id"],
                "amountOut": "100",
                "amountIn": "100",
                "occurredOn": A_DATE,
            },
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_fee_account_owned_by_another_user_is_404(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN a fee charged to an account owned by user B
        WHEN user A creates the transfer between A's accounts
        THEN it returns 404 and nothing is persisted — existence is never leaked (ADR-111)
        """
        # GIVEN — A owns the two transfer accounts; B owns a third account.
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            foreign = await _create_account(client_b)

        # WHEN — A points a fee at B's account.
        response = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "fees": [{"accountId": foreign["id"], "amount": "30", "label": "Sneaky fee"}],
            },
        )

        # THEN — 404, and the transfer did not commit (the source balance is untouched).
        assert response.status_code == status.HTTP_404_NOT_FOUND
        balances = await _net_worth_by_account(test_client)
        assert balances[source["id"]]["balance"] == "10000.00"


class TestTransferListAndDelete:
    """List is owner-scoped newest-first; delete is owner-scoped and keeps fees (ADR-135)."""

    async def test_list_returns_owned_transfers_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two transfers created on different dates
        WHEN the list endpoint is called
        THEN both are returned, newest-first by occurrence (ADR-130)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="100000")
        destination = await _create_account(test_client, opening_balance="0")
        for occurred_on in ("2026-06-01", "2026-06-20"):
            await test_client.post(
                TRANSFERS,
                json={
                    "fromAccountId": source["id"],
                    "toAccountId": destination["id"],
                    "amountOut": "100",
                    "amountIn": "100",
                    "occurredOn": occurred_on,
                },
            )

        # WHEN
        response = await test_client.get(TRANSFERS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        dates = [item["occurredOn"] for item in response.json()["data"]]
        assert dates == ["2026-06-20", "2026-06-01"]

    async def test_delete_removes_transfer_but_keeps_fee_expenses(self, test_client: httpx.AsyncClient):
        """
        GIVEN a transfer that created a fee expense
        WHEN the transfer is deleted
        THEN it is gone from the list (204) but the fee expense survives (ADR-135)
        """
        # GIVEN
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")
        created = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "2500",
                "amountIn": "2500",
                "occurredOn": A_DATE,
                "fees": [{"accountId": source["id"], "amount": "30", "label": "Transfer fee"}],
            },
        )
        transfer = created.json()["data"]
        fee_id = transfer["feeTransactionIds"][0]

        # WHEN
        response = await test_client.delete(f"{TRANSFERS}/{transfer['id']}")

        # THEN — the transfer is gone but the fee expense is independent and remains.
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert (await test_client.get(TRANSFERS)).json()["data"] == []
        transactions = (await test_client.get(TRANSACTIONS)).json()["data"]
        assert any(tx["id"] == fee_id for tx in transactions)
        # The transfer leg reverted (source back up), but the fee expense still applies.
        balances = await _net_worth_by_account(test_client)
        assert balances[source["id"]]["balance"] == "9970.00"  # 10000 - 30 fee, transfer reverted

    async def test_delete_missing_transfer_is_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no transfer with the requested id
        WHEN it is deleted
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.delete(f"{TRANSFERS}/{uuid4()}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestCrossTenant:
    """A user never sees or deletes another user's transfers (ADR-130, ADR-111)."""

    async def test_user_b_cannot_see_or_delete_user_a_transfer(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created a transfer
        WHEN user B lists transfers and deletes A's transfer id
        THEN B's list is empty and B's delete is a 404 — existence is never leaked
        """
        # GIVEN — user A (the default stub) creates a transfer.
        source = await _create_account(test_client, opening_balance="10000")
        destination = await _create_account(test_client, opening_balance="0")
        created = await test_client.post(
            TRANSFERS,
            json={
                "fromAccountId": source["id"],
                "toAccountId": destination["id"],
                "amountOut": "100",
                "amountIn": "100",
                "occurredOn": A_DATE,
            },
        )
        transfer_id = created.json()["data"]["id"]

        # WHEN / THEN — user B sees none of A's transfers and cannot delete one.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            list_b = await client_b.get(TRANSFERS)
            assert list_b.json()["data"] == []

            delete_b = await client_b.delete(f"{TRANSFERS}/{transfer_id}")
            assert delete_b.status_code == status.HTTP_404_NOT_FOUND


class TestDomainInvariantToHttp:
    """A domain invariant surfacing from the bus maps to the right status (ADR-031, ADR-135).

    Pydantic catches the obvious violations at the boundary, so to exercise the
    router's handler-level translation we drive the app with a bus whose ``handle``
    raises the domain exception directly (mirrors the accounts e2e pattern).
    """

    @pytest.fixture(name="raising_client")
    async def fixture_raising_client(self, request: pytest.FixtureRequest) -> AsyncIterator[httpx.AsyncClient]:
        """Build a client whose bus raises the parametrized domain exception."""
        error = request.param
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
        app = get_application(container)

        class _RaisingBus:
            async def handle(self, _message: object) -> None:
                raise error

        app.dependency_overrides[get_bus] = lambda: _RaisingBus()
        app.dependency_overrides[get_transfer_reader] = lambda: FakeTransferReader({})

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    def _create_body(self) -> dict:
        """A syntactically valid create body Pydantic accepts before the bus runs."""
        return {
            "fromAccountId": str(uuid4()),
            "toAccountId": str(uuid4()),
            "amountOut": "100",
            "amountIn": "100",
            "occurredOn": A_DATE,
        }

    @pytest.mark.parametrize("raising_client", [AccountNotFoundError(uuid4())], indirect=True)
    async def test_create_maps_missing_account_to_404(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a missing-account error
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 404 (ADR-111, ADR-130)
        """
        # WHEN
        response = await raising_client.post(TRANSFERS, json=self._create_body())

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.parametrize("raising_client", [SameAccountTransferError(uuid4())], indirect=True)
    async def test_create_maps_same_account_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a same-account invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422 (ADR-031)
        """
        # WHEN
        response = await raising_client.post(TRANSFERS, json=self._create_body())

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [InvalidAmountError(0)], indirect=True)
    async def test_create_maps_invalid_amount_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises an invalid-amount invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422 (ADR-031)
        """
        # WHEN
        response = await raising_client.post(TRANSFERS, json=self._create_body())

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [TransferNotFoundError(uuid4())], indirect=True)
    async def test_delete_maps_missing_transfer_to_404(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose delete handler raises a missing-transfer error
        WHEN a delete is sent
        THEN the router maps it to 404 (ADR-111)
        """
        # WHEN
        response = await raising_client.delete(f"{TRANSFERS}/{uuid4()}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
