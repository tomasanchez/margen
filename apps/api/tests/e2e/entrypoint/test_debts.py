"""Route tests for the debts entrypoint + the net-worth other-debts leg (ADR-187).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so debts are genuinely persisted and the net-worth ``liabilities.other``
leg aggregates through real SQL — the slice's core behaviour is exercised end to end, not
mocked. User A is the default stub (``STUB_USER_ID``); the cross-tenant checks use the
second stub (``STUB_AUTH_USER_B``) on a separate app over the SAME container via the
shared ``client_for_user`` factory.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.domain.models.exceptions import DebtNotFoundError, InvalidBalanceError, UnknownCurrencyError
from margen_api.entrypoint.dependencies import get_bus, get_debt_reader
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B
from tests.fakes.persistence import FakeDebtReader

DEBTS = "/api/v1/debts"
NET_WORTH = "/api/v1/accounts/net-worth"
INSTITUTIONS = "/api/v1/institutions"
ACCOUNTS = "/api/v1/accounts"


async def _create_debt(client: httpx.AsyncClient, **body: object) -> dict:
    """POST a debt and return the created resource, asserting 201."""
    defaults: dict[str, object] = {"name": "Banco Nación loan", "currency": "ARS", "currentBalance": "100000"}
    defaults.update(body)
    response = await client.post(DEBTS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


class TestDebtCrud:
    """List / create / update / delete over the debt aggregate (ADR-187, ADR-130)."""

    async def test_create_returns_201_with_camelcase_contract(self, test_client: httpx.AsyncClient):
        """
        GIVEN a valid create body carrying the extension points
        WHEN the debt is created
        THEN it returns 201 with the camelCase contract and decimal-string money
        """
        # WHEN
        created = await _create_debt(
            test_client,
            name="Car loan",
            currency="USD",
            currentBalance="2500.00",
            monthlyMinimum="100.00",
            rate="12.5000",
        )

        # THEN
        assert created["name"] == "Car loan"
        assert created["currency"] == "USD"
        assert created["currentBalance"] == "2500.00"
        assert created["monthlyMinimum"] == "100.00"
        assert created["rate"] == "12.5000"

    async def test_create_defaults_optional_fields_to_null(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body without the extension points
        WHEN the debt is created
        THEN monthlyMinimum and rate are null in the response
        """
        # WHEN
        created = await _create_debt(test_client, name="Informal debt")

        # THEN
        assert created["monthlyMinimum"] is None
        assert created["rate"] is None

    async def test_list_returns_owned_debts_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two created debts
        WHEN the list endpoint is called
        THEN both are returned, newest-first (ADR-130)
        """
        # GIVEN
        await _create_debt(test_client, name="First")
        await _create_debt(test_client, name="Second")

        # WHEN
        response = await test_client.get(DEBTS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        names = [item["name"] for item in response.json()["data"]]
        assert names == ["Second", "First"]

    async def test_patch_updates_present_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing debt
        WHEN it is patched with a new balance
        THEN the updated resource reflects the change
        """
        # GIVEN
        created = await _create_debt(test_client, currentBalance="100000")

        # WHEN
        response = await test_client.patch(f"{DEBTS}/{created['id']}", json={"currentBalance": "80000.00"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["currentBalance"] == "80000.00"

    async def test_delete_removes_debt(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing debt
        WHEN it is deleted
        THEN it returns 204 and disappears from the list
        """
        # GIVEN
        created = await _create_debt(test_client)

        # WHEN
        response = await test_client.delete(f"{DEBTS}/{created['id']}")

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT
        listing = await test_client.get(DEBTS)
        assert listing.json()["data"] == []

    async def test_patch_missing_debt_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no debt with the requested id
        WHEN it is patched
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.patch(
            f"{DEBTS}/00000000-0000-4000-8000-0000000000aa",
            json={"currentBalance": "1"},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_delete_missing_debt_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no debt with the requested id
        WHEN it is deleted
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.delete(f"{DEBTS}/00000000-0000-4000-8000-0000000000bb")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_negative_balance_is_rejected_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with a negative currentBalance
        WHEN the debt is created
        THEN Pydantic rejects it with 422 (a non-negative obligation, ADR-187)
        """
        # WHEN
        response = await test_client.post(DEBTS, json={"name": "Bad", "currentBalance": "-1"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_empty_name_is_rejected_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with an empty name
        WHEN the debt is created
        THEN Pydantic rejects it with 422 (ADR-024/031)
        """
        # WHEN
        response = await test_client.post(DEBTS, json={"name": "", "currentBalance": "100"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestDebtCrossTenant:
    """A user never sees, patches or deletes another user's debts (ADR-130, ADR-111)."""

    async def test_user_b_cannot_see_patch_or_delete_user_a_debt(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created a debt
        WHEN user B lists, patches and deletes A's debt id
        THEN B's list is empty and B's patch/delete are 404 — existence is never leaked
        """
        # GIVEN — user A (the default stub) creates a debt.
        created = await _create_debt(test_client)

        # WHEN / THEN — user B sees none of A's debts and cannot mutate them.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            list_b = await client_b.get(DEBTS)
            assert list_b.json()["data"] == []

            patch_b = await client_b.patch(f"{DEBTS}/{created['id']}", json={"currentBalance": "1"})
            assert patch_b.status_code == status.HTTP_404_NOT_FOUND

            delete_b = await client_b.delete(f"{DEBTS}/{created['id']}")
            assert delete_b.status_code == status.HTTP_404_NOT_FOUND


async def _create_account(client: httpx.AsyncClient, **body: object) -> dict:
    """Create a bank institution + an account under it, returning the account."""
    institution = (await client.post(INSTITUTIONS, json={"name": "Galicia", "type": "bank"})).json()["data"]
    defaults: dict[str, object] = {"institutionId": institution["id"], "currency": "ARS", "openingBalance": "0"}
    defaults.update(body)
    response = await client.post(ACCOUNTS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


class TestNetWorthOther:
    """The manual 'other debts' leg feeds net worth's liabilities.other (ADR-187)."""

    async def test_no_debts_yields_zero_other_and_native(self, test_client: httpx.AsyncClient):
        """
        GIVEN an owner with no debts
        WHEN net worth is read
        THEN other is a computed 0.00 and otherNative is zero (ADR-187)
        """
        # WHEN
        data = (await test_client.get(NET_WORTH)).json()["data"]

        # THEN
        assert data["liabilities"]["other"] == "0.00"
        assert data["liabilities"]["otherNative"] == {"ars": "0.00", "usd": "0.00"}

    async def test_ars_debt_reduces_net_after_liabilities(self, test_client: httpx.AsyncClient):
        """
        GIVEN an ARS account with assets and an owned ARS debt
        WHEN net worth is read
        THEN total stays assets-only, other = the debt, and netAfterLiabilities = total - other (ADR-187)
        """
        # GIVEN — 100,000 ARS assets; a 30,000 ARS manual debt (NOT an asset).
        await _create_account(test_client, openingBalance="100000")
        await _create_debt(test_client, name="Loan", currency="ARS", currentBalance="30000")

        # WHEN
        data = (await test_client.get(NET_WORTH)).json()["data"]

        # THEN — the debt never touches the assets total; it is the other leg.
        assert data["total"] == "100000.00"
        assert data["liabilities"]["other"] == "30000.00"
        assert data["liabilities"]["otherNative"] == {"ars": "30000.00", "usd": "0.00"}
        assert data["liabilities"]["total"] == "30000.00"
        assert data["netAfterLiabilities"] == "70000.00"

    async def test_usd_debt_converts_at_mep_and_keeps_native(self, test_client: httpx.AsyncClient):
        """
        GIVEN a USD debt and a USD MEP rate observed on a USD transaction
        WHEN net worth is read in ARS
        THEN other converts at MEP while otherNative.usd stays unconverted (ADR-183/187)
        """
        # GIVEN — an ARS account plus a USD account whose income seeds a 1000 ARS/USD MEP rate.
        await _create_account(test_client, openingBalance="0")
        usd_institution = (await test_client.post(INSTITUTIONS, json={"name": "Deel", "type": "wallet"})).json()["data"]
        usd_account = (
            await test_client.post(
                ACCOUNTS, json={"institutionId": usd_institution["id"], "currency": "USD", "openingBalance": "0"}
            )
        ).json()["data"]
        await test_client.post(
            "/api/v1/transactions",
            json={
                "occurredOn": "2026-06-12",
                "name": "Deel payout",
                "kind": "income",
                "amountNum": "50",
                "currency": "USD",
                "usd": "50",
                "rate": "1000",
                "accountId": usd_account["id"],
            },
        )
        # ...and a 100 USD manual debt.
        await _create_debt(test_client, name="USD loan", currency="USD", currentBalance="100")

        # WHEN
        data = (await test_client.get(NET_WORTH)).json()["data"]

        # THEN — 100 USD at 1000 ARS/USD = 100,000 ARS converted; native keeps the raw 100 USD.
        assert data["currency"] == "ARS"
        assert data["liabilities"]["other"] == "100000.00"
        assert data["liabilities"]["otherNative"] == {"ars": "0.00", "usd": "100.00"}

    async def test_other_is_owner_scoped(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user B has a manual debt
        WHEN user A reads net worth
        THEN A's other leg is unaffected by B's debts (ADR-108, ADR-130)
        """
        # GIVEN — user B records a debt.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            await _create_debt(client_b, name="B loan", currency="ARS", currentBalance="99999")

        # WHEN — user A (the default stub) reads net worth with no debts of their own.
        data = (await test_client.get(NET_WORTH)).json()["data"]

        # THEN — A's other leg is zero; B's debt never leaks.
        assert data["liabilities"]["other"] == "0.00"
        assert data["liabilities"]["otherNative"] == {"ars": "0.00", "usd": "0.00"}


class TestDomainInvariantToHttp:
    """A domain invariant surfacing from the bus maps to the right status (ADR-031, ADR-187).

    Pydantic catches the obvious violations at the boundary, so to exercise the router's
    handler-level translation we drive the app with a bus whose ``handle`` raises the
    domain exception directly (mirrors the accounts e2e pattern).
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
        app.dependency_overrides[get_debt_reader] = lambda: FakeDebtReader({})

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
        response = await raising_client.post(DEBTS, json={"name": "Loan", "currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [InvalidBalanceError("-1")], indirect=True)
    async def test_create_maps_invalid_balance_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a negative-balance invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422 (ADR-187)
        """
        # WHEN
        response = await raising_client.post(DEBTS, json={"name": "Loan", "currentBalance": "5"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [DebtNotFoundError(uuid4())], indirect=True)
    async def test_update_maps_not_found_to_404(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose update handler raises a not-found error
        WHEN a syntactically valid patch is sent
        THEN the router maps it to 404 (ADR-111)
        """
        # WHEN
        response = await raising_client.patch(f"{DEBTS}/{uuid4()}", json={"currentBalance": "1"})

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
        response = await raising_client.patch(f"{DEBTS}/{uuid4()}", json={"currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize("raising_client", [DebtNotFoundError(uuid4())], indirect=True)
    async def test_delete_maps_not_found_to_404(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose delete handler raises a not-found error
        WHEN a delete is sent
        THEN the router maps it to 404 (ADR-111)
        """
        # WHEN
        response = await raising_client.delete(f"{DEBTS}/{uuid4()}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
