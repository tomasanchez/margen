"""Per-user settings route tests over the REAL adapters on SQLite (ADR-054, ADR-110).

Unlike :mod:`test_settings` (which mocks the reader and the unit of work to assert
the HTTP contract), these drive the FastAPI app through the REAL settings reader
and unit of work on the in-memory async SQLite e2e tier (ADR-019/032). They prove
the per-user behavior ADR-110 introduces and the mocked tier cannot:

* a GET for a logged-in user with no row yet returns the documented defaults
  without 404ing (the row is lazily created on first PATCH, not at read),
* a PATCH get-or-creates the caller's own row and a later GET reflects it, and
* two users' settings are independent — user B's PATCH never touches user A's row,
  and each user gets their own default before they write (cross-tenant isolation).
"""

from __future__ import annotations

import httpx
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer
from margen_api.entrypoint.dependencies import AuthUserModel, require_auth_user

SETTINGS = "/api/v1/settings"

# A second authenticated identity used to prove per-user isolation (ADR-110). It is
# a valid UUID string with hex letters so it stays TEXT (not NUMERIC) on the
# in-memory SQLite ``UUID`` ownership column, mirroring ``STUB_USER_ID``.
_USER_B_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678"
_USER_B = AuthUserModel(id=_USER_B_ID, email="userb@example.com", claims={"sub": _USER_B_ID})


def _client_for(container: ApplicationContainer, user: AuthUserModel) -> httpx.AsyncClient:
    """Build an async client over the SAME container authenticated as ``user``."""
    app = get_application(container)
    app.dependency_overrides[require_auth_user] = lambda: user
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


class TestGetOrCreate:
    """A logged-in user always gets settings; the row is created lazily (ADR-110)."""

    async def test_get_returns_defaults_without_a_row(self, test_client: httpx.AsyncClient):
        """
        GIVEN the stub user has never written settings
        WHEN they GET /settings
        THEN it returns 200 with the documented defaults (never 404)
        """
        # WHEN
        response = await test_client.get(SETTINGS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["preferredDisplayCurrency"] == "ARS"
        assert data["fxDefaultRateType"] == "MEP"
        assert data["monotributoCurrentCategory"] == "C"
        assert data["monotributoActivityType"] == "services"

    async def test_patch_then_get_round_trips_for_the_owner(self, test_client: httpx.AsyncClient):
        """
        GIVEN the stub user with no row yet
        WHEN they PATCH a category (get-or-create) and GET back
        THEN the GET reflects the value the PATCH committed to their own row
        """
        # WHEN — the first PATCH lazily creates the owner's row, then merges.
        patched = await test_client.patch(SETTINGS, json={"monotributoCurrentCategory": "K"})

        # THEN — the PATCH echoes the merge and a later GET sees the committed value.
        assert patched.status_code == status.HTTP_200_OK
        assert patched.json()["data"]["monotributoCurrentCategory"] == "K"
        data = (await test_client.get(SETTINGS)).json()["data"]
        assert data["monotributoCurrentCategory"] == "K"


class TestPerUserIsolation:
    """Each user owns an independent settings row (ADR-110)."""

    async def test_user_b_settings_are_independent_of_user_a(
        self, test_client: httpx.AsyncClient, container: ApplicationContainer
    ):
        """
        GIVEN user A (the stub) has set their currency to USD
        WHEN user B reads, then patches their own currency, then both read back
        THEN user B starts from the defaults (not A's value), B's write lands on B's
             own row, and A's row is left untouched — full per-user isolation
        """
        # GIVEN — user A sets USD on their own row.
        await test_client.patch(SETTINGS, json={"preferredDisplayCurrency": "USD"})

        async with _client_for(container, _USER_B) as client_b:
            # THEN — user B does NOT inherit A's USD; they get their own defaults.
            before = (await client_b.get(SETTINGS)).json()["data"]
            assert before["preferredDisplayCurrency"] == "ARS"

            # WHEN — user B sets their own currency to a different value.
            await client_b.patch(SETTINGS, json={"monotributoCurrentCategory": "H"})

            # THEN — B's category lands on B's row; A's currency is still USD,
            # and A's category is still the default (B's write never touched it).
            after_b = (await client_b.get(SETTINGS)).json()["data"]
            assert after_b["monotributoCurrentCategory"] == "H"
            assert after_b["preferredDisplayCurrency"] == "ARS"

        after_a = (await test_client.get(SETTINGS)).json()["data"]
        assert after_a["preferredDisplayCurrency"] == "USD"
        assert after_a["monotributoCurrentCategory"] == "C"
