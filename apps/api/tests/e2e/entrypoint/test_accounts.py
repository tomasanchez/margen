"""Route tests for the accounts + net-worth entrypoint (ADR-122, ADR-123, ADR-131).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so accounts and transactions are genuinely persisted and net worth
aggregates through real SQL — the slice's core behavior (per-account balance,
mixed-currency MEP conversion, balance reconciliation) is exercised end to end, not
mocked. User A is the default stub (``STUB_USER_ID``); the cross-tenant checks use
the second stub (``STUB_USER_ID_B``) on a separate app over the SAME container via
the shared ``client_for_user`` factory.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.domain.models.exceptions import UnknownAccountTypeError, UnknownCurrencyError
from margen_api.entrypoint.dependencies import get_account_reader, get_bus
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B
from tests.fakes.persistence import FakeAccountReader

ACCOUNTS = "/api/v1/accounts"
NET_WORTH = "/api/v1/accounts/net-worth"
TRANSACTIONS = "/api/v1/transactions"
A_DATE = "2026-06-12"


async def _create_account(client: httpx.AsyncClient, **body: object) -> dict:
    """POST an account and return the created resource, asserting 201."""
    defaults: dict[str, object] = {"name": "Galicia", "type": "bank", "currency": "ARS", "openingBalance": "0"}
    defaults.update(body)
    response = await client.post(ACCOUNTS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


class TestAccountCrud:
    """List / create / update over the account aggregate (ADR-122)."""

    async def test_create_returns_201_with_decimal_string_opening_balance(self, test_client: httpx.AsyncClient):
        """
        GIVEN a valid create body
        WHEN the account is created
        THEN it returns 201 with the pinned JSON shape and a decimal-string balance
        """
        # WHEN
        created = await _create_account(test_client, name="Cash ARS", type="cash", openingBalance="25000.00")

        # THEN
        assert created["name"] == "Cash ARS"
        assert created["type"] == "cash"
        assert created["currency"] == "ARS"
        assert created["openingBalance"] == "25000.00"

    async def test_list_returns_owned_accounts_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two created accounts
        WHEN the list endpoint is called
        THEN both are returned, newest-first (ADR-130)
        """
        # GIVEN
        await _create_account(test_client, name="First")
        await _create_account(test_client, name="Second")

        # WHEN
        response = await test_client.get(ACCOUNTS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        names = [item["name"] for item in response.json()["data"]]
        assert names == ["Second", "First"]

    async def test_patch_updates_present_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing account
        WHEN it is patched with a new name and opening balance
        THEN the updated resource reflects the change
        """
        # GIVEN
        created = await _create_account(test_client, name="Galicia", openingBalance="0")

        # WHEN
        response = await test_client.patch(
            f"{ACCOUNTS}/{created['id']}",
            json={"name": "Galicia Pesos", "openingBalance": "100.50"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["name"] == "Galicia Pesos"
        assert data["openingBalance"] == "100.50"

    async def test_unknown_type_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with an unknown account type
        WHEN the account is created
        THEN it returns 422 (lenient validation rejects only true invariants, ADR-031)
        """
        # WHEN
        response = await test_client.post(ACCOUNTS, json={"name": "X", "type": "crypto"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_patch_missing_account_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no account with the requested id
        WHEN it is patched
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.patch(
            f"{ACCOUNTS}/00000000-0000-4000-8000-0000000000aa",
            json={"name": "X"},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestCrossTenant:
    """A user never sees or mutates another user's accounts (ADR-130, ADR-111)."""

    async def test_user_b_cannot_see_or_patch_user_a_account(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created an account
        WHEN user B lists accounts and patches A's account id
        THEN B's list is empty and B's patch is a 404 — existence is never leaked
        """
        # GIVEN — user A (the default stub) creates an account.
        created = await _create_account(test_client, name="A's Galicia")

        # WHEN / THEN — user B sees none of A's accounts.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            list_b = await client_b.get(ACCOUNTS)
            assert list_b.json()["data"] == []

            patch_b = await client_b.patch(f"{ACCOUNTS}/{created['id']}", json={"name": "hijack"})
            assert patch_b.status_code == status.HTTP_404_NOT_FOUND


class TestTransactionAccountLink:
    """A transaction carries account_id and the link is owner-checked (ADR-130)."""

    async def test_transaction_carries_account_id(self, test_client: httpx.AsyncClient):
        """
        GIVEN an account owned by the caller
        WHEN a transaction is created linking it
        THEN the response carries the accountId
        """
        # GIVEN
        account = await _create_account(test_client, name="Galicia")

        # WHEN
        response = await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Coto",
                "kind": "expense",
                "amountNum": "250",
                "accountId": account["id"],
            },
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED, response.text
        assert response.json()["data"]["accountId"] == account["id"]

    async def test_linking_unknown_account_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no account with the referenced id
        WHEN a transaction is created linking it
        THEN it returns 404 (ADR-130, ADR-111)
        """
        # WHEN
        response = await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Coto",
                "kind": "expense",
                "amountNum": "250",
                "accountId": "00000000-0000-4000-8000-0000000000bb",
            },
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_patch_linking_unknown_account_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing transaction owned by the caller
        WHEN it is patched to link an account id that does not exist
        THEN it returns 404 (ADR-130, ADR-111)
        """
        # GIVEN — a transaction with no account link yet.
        created = await test_client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "name": "Coto", "kind": "expense", "amountNum": "250"},
        )
        transaction_id = created.json()["data"]["id"]

        # WHEN
        response = await test_client.patch(
            f"{TRANSACTIONS}/{transaction_id}",
            json={"accountId": "00000000-0000-4000-8000-0000000000cc"},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_linking_another_users_account_returns_404(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN an account owned by user A
        WHEN user B creates a transaction linking A's account
        THEN it returns 404 — existence is never leaked (ADR-130, ADR-111)
        """
        # GIVEN — A creates an account.
        account = await _create_account(test_client, name="A's account")

        # WHEN / THEN — B tries to link it.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.post(
                TRANSACTIONS,
                json={
                    "occurredOn": A_DATE,
                    "name": "Coto",
                    "kind": "expense",
                    "amountNum": "250",
                    "accountId": account["id"],
                },
            )
            assert response.status_code == status.HTTP_404_NOT_FOUND


class TestNetWorth:
    """Net worth = Σ (opening + signed deltas) converted via MEP FX (ADR-122, ADR-123)."""

    async def test_balance_reconciles_opening_plus_signed_deltas(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS account with an opening balance and one income + one expense
        WHEN net worth is read
        THEN the account balance is opening + income - expense (ADR-122)
        """
        # GIVEN — opening 10000; +5000 income; -2000 expense => balance 13000.
        account = await _create_account(test_client, name="Galicia", openingBalance="10000")
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Salary",
                "kind": "income",
                "amountNum": "5000",
                "accountId": account["id"],
            },
        )
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Rent",
                "kind": "expense",
                "amountNum": "2000",
                "accountId": account["id"],
            },
        )

        # WHEN
        response = await test_client.get(NET_WORTH)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currency"] == "ARS"
        assert data["total"] == "13000.00"
        only = data["accounts"][0]
        assert only["balance"] == "13000.00"
        assert only["balanceConverted"] == "13000.00"

    async def test_mixed_currency_net_worth_uses_mep_rate_from_usd_row(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS account and a USD account, with a USD transaction carrying a MEP rate
        WHEN net worth is read in ARS
        THEN the USD balance is converted at the row's MEP rate and added (ADR-123)
        """
        # GIVEN — an ARS account holding 100000.
        await _create_account(test_client, name="Galicia", currency="ARS", openingBalance="100000")
        # A USD account; its only movement is a +50 USD income carrying a 1000 ARS/USD MEP rate.
        usd = await _create_account(test_client, name="Deel USD", currency="USD", openingBalance="0")
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "Deel payout",
                "kind": "income",
                "amountNum": "50",
                "currency": "USD",
                "usd": "50",
                "rate": "1000",
                "accountId": usd["id"],
            },
        )

        # WHEN
        response = await test_client.get(NET_WORTH)

        # THEN — 100000 ARS + (50 USD * 1000) = 150000 ARS.
        data = response.json()["data"]
        assert data["total"] == "150000.00"
        by_currency = {item["currency"]: item for item in data["accounts"]}
        assert by_currency["USD"]["balance"] == "50.00"
        assert by_currency["USD"]["balanceConverted"] == "50000.00"
        assert by_currency["ARS"]["balanceConverted"] == "100000.00"


class TestDomainInvariantToHttp:
    """A domain invariant surfacing from the bus maps to 422 (ADR-031).

    Pydantic catches the obvious violations at the boundary, so to exercise the
    router's handler-level translation we drive the app with a bus whose ``handle``
    raises the domain exception directly (mirrors the transactions e2e pattern).
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
        app.dependency_overrides[get_account_reader] = lambda: FakeAccountReader({})

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    @pytest.mark.parametrize(
        "raising_client",
        [UnknownAccountTypeError("crypto"), UnknownCurrencyError("EUR")],
        indirect=True,
    )
    async def test_create_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a domain invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.post(ACCOUNTS, json={"name": "X", "type": "bank"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize(
        "raising_client",
        [UnknownAccountTypeError("crypto"), UnknownCurrencyError("EUR")],
        indirect=True,
    )
    async def test_update_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose update handler raises a domain invariant violation
        WHEN a syntactically valid patch is sent
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.patch(f"{ACCOUNTS}/{uuid4()}", json={"name": "X"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
