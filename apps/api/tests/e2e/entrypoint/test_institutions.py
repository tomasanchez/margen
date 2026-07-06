"""Route tests for the institutions entrypoint (ADR-130, ADR-134).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so institutions are genuinely persisted. User A is the default stub
(``STUB_USER_ID``); the cross-tenant check uses the second stub (``STUB_USER_ID_B``)
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
from margen_api.domain.models.exceptions import (
    EmptyCardBrandError,
    EmptyNameError,
    InvalidCardLast4Error,
    UnknownInstitutionTypeError,
)
from margen_api.entrypoint.dependencies import get_bus, get_institution_reader
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B
from tests.fakes.persistence import FakeInstitutionReader

INSTITUTIONS = "/api/v1/institutions"


async def _create_institution(client: httpx.AsyncClient, **body: object) -> dict:
    """POST an institution and return the created resource, asserting 201."""
    defaults: dict[str, object] = {"name": "Galicia", "type": "bank"}
    defaults.update(body)
    response = await client.post(INSTITUTIONS, json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


class TestInstitutionCrud:
    """List / create / update over the institution aggregate (ADR-134)."""

    async def test_create_returns_201_with_pinned_shape(self, test_client: httpx.AsyncClient):
        """
        GIVEN a valid create body for a wallet provider
        WHEN the institution is created
        THEN it returns 201 with the pinned JSON shape (id, name, type)
        """
        # WHEN
        created = await _create_institution(test_client, name="Deel", type="wallet")

        # THEN
        assert created["name"] == "Deel"
        assert created["type"] == "wallet"
        assert "id" in created

    async def test_create_card_persists_and_returns_brand_and_last4(self, test_client: httpx.AsyncClient):
        """
        GIVEN a valid create body for a CARD carrying brand + last4 (ADR-190)
        WHEN the institution is created and then listed
        THEN the card identity is persisted and returned in camelCase JSON
        """
        # WHEN
        created = await _create_institution(test_client, name="Galicia", type="card", brand="VISA", last4="5771")

        # THEN — the create response carries the card identity.
        assert created["type"] == "card"
        assert created["brand"] == "VISA"
        assert created["last4"] == "5771"

        # THEN — it round-trips through the list read model too.
        listed = (await test_client.get(INSTITUTIONS)).json()["data"]
        card = next(item for item in listed if item["id"] == created["id"])
        assert card["brand"] == "VISA"
        assert card["last4"] == "5771"

    async def test_non_card_institution_returns_null_brand_and_last4(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body for a bank that omits brand + last4
        WHEN the institution is created
        THEN both brand and last4 are null (non-card kinds are unaffected, ADR-190)
        """
        # WHEN
        created = await _create_institution(test_client, name="Galicia", type="bank")

        # THEN
        assert created["brand"] is None
        assert created["last4"] is None

    async def test_invalid_last4_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body whose last4 is not four digits
        WHEN the institution is created
        THEN it returns 422 (the card-identity invariant is enforced, ADR-190/031)
        """
        # WHEN
        response = await test_client.post(
            INSTITUTIONS, json={"name": "Galicia", "type": "card", "brand": "VISA", "last4": "57"}
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_list_returns_owned_institutions_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two created institutions
        WHEN the list endpoint is called
        THEN both are returned, newest-first (ADR-130)
        """
        # GIVEN
        await _create_institution(test_client, name="First")
        await _create_institution(test_client, name="Second")

        # WHEN
        response = await test_client.get(INSTITUTIONS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        names = [item["name"] for item in response.json()["data"]]
        assert names == ["Second", "First"]

    async def test_patch_updates_present_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing institution
        WHEN it is patched with a new name and type
        THEN the updated resource reflects the change
        """
        # GIVEN
        created = await _create_institution(test_client, name="Galicia", type="bank")

        # WHEN
        response = await test_client.patch(
            f"{INSTITUTIONS}/{created['id']}",
            json={"name": "Galicia Card", "type": "card"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["name"] == "Galicia Card"
        assert data["type"] == "card"

    async def test_unknown_type_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with an unknown institution type
        WHEN the institution is created
        THEN it returns 422 (lenient validation rejects only true invariants, ADR-031)
        """
        # WHEN
        response = await test_client.post(INSTITUTIONS, json={"name": "X", "type": "crypto"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_patch_missing_institution_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no institution with the requested id
        WHEN it is patched
        THEN it returns 404 (ADR-111)
        """
        # WHEN
        response = await test_client.patch(
            f"{INSTITUTIONS}/00000000-0000-4000-8000-0000000000aa",
            json={"name": "X"},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestCrossTenant:
    """A user never sees or mutates another user's institutions (ADR-130, ADR-111)."""

    async def test_user_b_cannot_see_or_patch_user_a_institution(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created an institution
        WHEN user B lists institutions and patches A's institution id
        THEN B's list is empty and B's patch is a 404 — existence is never leaked
        """
        # GIVEN — user A (the default stub) creates an institution.
        created = await _create_institution(test_client, name="A's Galicia")

        # WHEN / THEN — user B sees none of A's institutions.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            list_b = await client_b.get(INSTITUTIONS)
            assert list_b.json()["data"] == []

            patch_b = await client_b.patch(f"{INSTITUTIONS}/{created['id']}", json={"name": "hijack"})
            assert patch_b.status_code == status.HTTP_404_NOT_FOUND


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
        app.dependency_overrides[get_institution_reader] = lambda: FakeInstitutionReader({})

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    @pytest.mark.parametrize(
        "raising_client",
        [
            UnknownInstitutionTypeError("crypto"),
            EmptyNameError(),
            InvalidCardLast4Error("57"),
            EmptyCardBrandError(),
        ],
        indirect=True,
    )
    async def test_create_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a domain invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.post(INSTITUTIONS, json={"name": "X", "type": "bank"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize(
        "raising_client",
        [
            UnknownInstitutionTypeError("crypto"),
            EmptyNameError(),
            InvalidCardLast4Error("57"),
            EmptyCardBrandError(),
        ],
        indirect=True,
    )
    async def test_update_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose update handler raises a domain invariant violation
        WHEN a syntactically valid patch is sent
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.patch(f"{INSTITUTIONS}/{uuid4()}", json={"name": "X"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
