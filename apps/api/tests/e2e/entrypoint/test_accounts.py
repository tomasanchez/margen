"""Route tests for the accounts + net-worth entrypoint (ADR-122, ADR-123, ADR-134).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so institutions, accounts and transactions are genuinely persisted
and net worth aggregates through real SQL — the slice's core behavior (per-account
balance, mixed-currency MEP conversion, balance reconciliation) is exercised end to
end, not mocked. An account is a per-currency leaf under an institution (ADR-134),
so each test first creates an institution. User A is the default stub
(``STUB_USER_ID``); the cross-tenant checks use the second stub (``STUB_USER_ID_B``)
on a separate app over the SAME container via the shared ``client_for_user`` factory.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.domain.models.exceptions import InstitutionNotFoundError, UnknownCurrencyError
from margen_api.entrypoint.dependencies import get_account_reader, get_bus
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B
from tests.fakes.persistence import FakeAccountReader

ACCOUNTS = "/api/v1/accounts"
INSTITUTIONS = "/api/v1/institutions"
NET_WORTH = "/api/v1/accounts/net-worth"
TRANSACTIONS = "/api/v1/transactions"
A_DATE = "2026-06-12"


async def _create_institution(client: httpx.AsyncClient, **body: object) -> dict:
    """POST an institution and return the created resource, asserting 201."""
    defaults: dict[str, object] = {"name": "Galicia", "type": "bank"}
    defaults.update(body)
    response = await client.post(INSTITUTIONS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


async def _create_account(client: httpx.AsyncClient, *, institution_id: str | None = None, **body: object) -> dict:
    """POST an account under an institution and return the created resource, asserting 201.

    Creates a default institution first when ``institution_id`` is not supplied.
    """
    if institution_id is None:
        institution_id = (await _create_institution(client))["id"]
    defaults: dict[str, object] = {"institutionId": institution_id, "currency": "ARS", "openingBalance": "0"}
    defaults.update(body)
    response = await client.post(ACCOUNTS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


class TestAccountCrud:
    """List / create / update over the account aggregate (ADR-122, ADR-134)."""

    async def test_create_returns_201_with_denormalized_institution_and_decimal_balance(
        self, test_client: httpx.AsyncClient
    ):
        """
        GIVEN an institution and a valid create body
        WHEN the account is created
        THEN it returns 201 with the institution name/type denormalized and a decimal-string balance
        """
        # GIVEN
        institution = await _create_institution(test_client, name="Deel", type="wallet")

        # WHEN
        created = await _create_account(
            test_client, institution_id=institution["id"], currency="USD", openingBalance="25000.00"
        )

        # THEN — the account carries the institution's name + type plus its own currency (ADR-134).
        assert created["institutionId"] == institution["id"]
        assert created["institutionName"] == "Deel"
        assert created["type"] == "wallet"
        assert created["currency"] == "USD"
        assert created["openingBalance"] == "25000.00"

    async def test_list_returns_owned_accounts_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two created accounts under the same institution
        WHEN the list endpoint is called
        THEN both are returned, newest-first (ADR-130)
        """
        # GIVEN
        institution = await _create_institution(test_client, name="Galicia")
        await _create_account(test_client, institution_id=institution["id"], currency="ARS")
        await _create_account(test_client, institution_id=institution["id"], currency="USD")

        # WHEN
        response = await test_client.get(ACCOUNTS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        currencies = [item["currency"] for item in response.json()["data"]]
        assert currencies == ["USD", "ARS"]
        assert all(item["institutionName"] == "Galicia" for item in response.json()["data"])

    async def test_patch_updates_present_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing account
        WHEN it is patched with a new opening balance
        THEN the updated resource reflects the change
        """
        # GIVEN
        created = await _create_account(test_client, openingBalance="0")

        # WHEN
        response = await test_client.patch(
            f"{ACCOUNTS}/{created['id']}",
            json={"openingBalance": "100.50"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["openingBalance"] == "100.50"

    async def test_patch_reassigns_to_another_owned_institution(self, test_client: httpx.AsyncClient):
        """
        GIVEN an account under one owned institution and a second owned institution
        WHEN the account is patched to link the second institution
        THEN the updated resource reflects the new institution (ownership re-checked, ADR-134)
        """
        # GIVEN
        first = await _create_institution(test_client, name="Galicia")
        second = await _create_institution(test_client, name="Deel", type="wallet")
        account = await _create_account(test_client, institution_id=first["id"])

        # WHEN
        response = await test_client.patch(
            f"{ACCOUNTS}/{account['id']}",
            json={"institutionId": second["id"]},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["institutionId"] == second["id"]
        assert data["institutionName"] == "Deel"
        assert data["type"] == "wallet"

    async def test_create_with_unknown_institution_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body referencing an institution that does not exist
        WHEN the account is created
        THEN it returns 404 (ADR-130, ADR-134)
        """
        # WHEN
        response = await test_client.post(
            ACCOUNTS,
            json={"institutionId": "00000000-0000-4000-8000-0000000000dd", "currency": "ARS"},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_patch_missing_account_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no account with the requested id
        WHEN it is patched
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.patch(
            f"{ACCOUNTS}/00000000-0000-4000-8000-0000000000aa",
            json={"openingBalance": "1"},
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
        created = await _create_account(test_client)

        # WHEN / THEN — user B sees none of A's accounts.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            list_b = await client_b.get(ACCOUNTS)
            assert list_b.json()["data"] == []

            patch_b = await client_b.patch(f"{ACCOUNTS}/{created['id']}", json={"openingBalance": "1"})
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
        account = await _create_account(test_client)

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
        account = await _create_account(test_client)

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

    async def test_no_accounts_returns_zero_total_and_empty_breakdown(self, test_client: httpx.AsyncClient):
        """
        GIVEN an owner with no accounts (the table starts empty, ADR-124 amended)
        WHEN net worth is read
        THEN it returns 200 with a zero total, the default display currency, and no accounts
        """
        # WHEN
        response = await test_client.get(NET_WORTH)

        # THEN — accounts are not auto-seeded, so net worth degrades gracefully to zero.
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["total"] == "0.00"
        assert data["currency"] == "ARS"
        assert data["accounts"] == []

    async def test_balance_reconciles_opening_plus_signed_deltas(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS account with an opening balance and one income + one expense
        WHEN net worth is read
        THEN the account balance is opening + income - expense and carries the institution (ADR-122, ADR-134)
        """
        # GIVEN — opening 10000; +5000 income; -2000 expense => balance 13000.
        institution = await _create_institution(test_client, name="Galicia")
        account = await _create_account(test_client, institution_id=institution["id"], openingBalance="10000")
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
        assert only["institutionName"] == "Galicia"
        assert only["type"] == "bank"

    async def test_mixed_currency_under_one_institution_uses_mep_rate(self, test_client: httpx.AsyncClient):
        """
        GIVEN one institution holding an ARS account and a USD account, with a USD MEP rate
        WHEN net worth is read in ARS
        THEN the USD balance is converted at the row's MEP rate and added (ADR-123, ADR-134)
        """
        # GIVEN — a single "Galicia" institution with an ARS leaf holding 100000.
        institution = await _create_institution(test_client, name="Galicia")
        await _create_account(test_client, institution_id=institution["id"], currency="ARS", openingBalance="100000")
        # ...and a USD leaf; its only movement is a +50 USD income carrying a 1000 ARS/USD MEP rate.
        usd = await _create_account(test_client, institution_id=institution["id"], currency="USD", openingBalance="0")
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

        # THEN — 100000 ARS + (50 USD * 1000) = 150000 ARS, both under "Galicia".
        data = response.json()["data"]
        assert data["total"] == "150000.00"
        by_currency = {item["currency"]: item for item in data["accounts"]}
        assert by_currency["USD"]["balance"] == "50.00"
        assert by_currency["USD"]["balanceConverted"] == "50000.00"
        assert by_currency["USD"]["institutionName"] == "Galicia"
        assert by_currency["ARS"]["balanceConverted"] == "100000.00"
        assert by_currency["ARS"]["institutionName"] == "Galicia"


class TestDomainInvariantToHttp:
    """A domain invariant surfacing from the bus maps to the right status (ADR-031, ADR-134).

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

    @pytest.mark.parametrize("raising_client", [UnknownCurrencyError("EUR")], indirect=True)
    async def test_create_maps_unknown_currency_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises an unknown-currency invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.post(ACCOUNTS, json={"institutionId": str(uuid4()), "currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [InstitutionNotFoundError(uuid4())], indirect=True)
    async def test_create_maps_missing_institution_to_404(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a missing-institution error
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 404 (ADR-111, ADR-134)
        """
        # WHEN
        response = await raising_client.post(ACCOUNTS, json={"institutionId": str(uuid4()), "currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.parametrize("raising_client", [UnknownCurrencyError("EUR")], indirect=True)
    async def test_update_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose update handler raises a domain invariant violation
        WHEN a syntactically valid patch is sent
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.patch(f"{ACCOUNTS}/{uuid4()}", json={"currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
