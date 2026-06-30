"""Route tests for the application settings entrypoint (ADR-054, ADR-030, ADR-032).

Per ADR-032 these drive the FastAPI app through the ASGI client **fully mocked**:
``get_settings_reader`` resolves a :class:`FakeSettingsReader` over the same
single-row dict the bus's :class:`FakeUnitOfWork` writes to, and ``get_bus``
resolves a real :class:`MessageBus` whose unit of work is that in-memory
:class:`FakeUnitOfWork`. No SQLite, no Postgres -- these assert the HTTP contract
(the ``{data}`` envelope, camelCase keys), the partial-PATCH round-trip echoed by
the handler, that the write actually committed through the fake unit of work, and
that an unknown currency / FX default / category maps to ``422`` (ADR-030).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.entrypoint.dependencies import get_bus, get_settings_reader
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.settings.database_settings import DatabaseSettings
from tests.fakes.persistence import FakeSettingsReader, FakeUnitOfWork

SETTINGS = "/api/v1/settings"


@pytest.fixture(name="uow")
def fixture_uow() -> FakeUnitOfWork:
    """Provide a single shared in-memory unit of work for the app under test."""
    return FakeUnitOfWork()


def _build_client(uow: FakeUnitOfWork) -> tuple[httpx.AsyncClient, ApplicationContainer]:
    """Build an ASGI app whose bus + settings reader dependencies are mocked.

    The bus is real (the update command flows through the registered handler) but
    its unit of work is the shared :class:`FakeUnitOfWork`; the settings reader is
    a :class:`FakeSettingsReader` over that unit of work's ``config`` dict so a GET
    after a PATCH reflects the committed write (the round-trip). The container is
    bootstrapped on in-memory SQLite only to satisfy ``get_application`` -- its
    engine is never touched because both persistence dependencies are overridden.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)

    bus = MessageBus(
        uow_factory=lambda: uow,
        command_handlers=dict(COMMAND_HANDLERS),
        event_handlers={event: list(handlers) for event, handlers in EVENT_HANDLERS.items()},
    )
    app.dependency_overrides[get_bus] = lambda: bus
    app.dependency_overrides[get_settings_reader] = lambda: FakeSettingsReader(uow.config)

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test"), container


@pytest.fixture(name="client")
async def fixture_client(uow: FakeUnitOfWork) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose bus + settings reader are mocked."""
    client, container = _build_client(uow)
    async with client:
        yield client
    await container.shutdown()


class TestGetSettings:
    """GET /settings returns the envelope with camelCase keys (ADR-030/054)."""

    async def test_returns_documented_defaults_envelope(self, client: httpx.AsyncClient):
        """
        GIVEN no settings written yet
        WHEN the settings endpoint is requested
        THEN it returns 200 with the {data} envelope carrying the documented
             defaults under camelCase keys
        """
        # WHEN
        response = await client.get(SETTINGS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert set(data) == {
            "preferredDisplayCurrency",
            "fxDefaultRateType",
            "preferredRateSource",
            "monotributoCurrentCategory",
            "monotributoActivityType",
            "monotributoEnabled",
        }
        assert data["preferredDisplayCurrency"] == "ARS"
        assert data["fxDefaultRateType"] == "MEP"
        # The persisted preferred rate source defaults to 'bolsa' (ADR-151).
        assert data["preferredRateSource"] == "bolsa"
        assert data["monotributoCurrentCategory"] == "C"
        assert data["monotributoActivityType"] == "services"
        # New users default to the Monotributo module OFF (ADR-126).
        assert data["monotributoEnabled"] is False

    async def test_reflects_persisted_values(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a settings row already populated
        WHEN the settings endpoint is requested
        THEN the persisted values come back in the envelope
        """
        # GIVEN
        uow.config.update(
            {
                "preferred_display_currency": "USD",
                "fx_default_rate_type": "official",
                "current_category": "H",
                "activity_type": "bienes",
                "monotributo_enabled": True,
            }
        )

        # WHEN
        data = (await client.get(SETTINGS)).json()["data"]

        # THEN
        assert data["preferredDisplayCurrency"] == "USD"
        assert data["fxDefaultRateType"] == "official"
        assert data["monotributoCurrentCategory"] == "H"
        assert data["monotributoActivityType"] == "bienes"
        assert data["monotributoEnabled"] is True


class TestPatchSettings:
    """PATCH /settings partially updates, echoes the result and commits (ADR-054)."""

    async def test_partial_update_echoes_and_commits(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN existing settings and a body that changes only the display currency
        WHEN the settings endpoint is patched
        THEN it returns 200 with the merged result, only the one field changed, and
             the write committed through the fake unit of work
        """
        # GIVEN — start from a populated row.
        uow.config.update(
            {
                "preferred_display_currency": "ARS",
                "fx_default_rate_type": "MEP",
                "current_category": "C",
                "activity_type": "services",
            }
        )

        # WHEN
        response = await client.patch(SETTINGS, json={"preferredDisplayCurrency": "USD"})

        # THEN — the merged result is echoed; only the currency changed; committed.
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["preferredDisplayCurrency"] == "USD"
        assert data["fxDefaultRateType"] == "MEP"
        assert data["monotributoCurrentCategory"] == "C"
        assert uow.committed is True

    async def test_patch_then_get_round_trips(self, client: httpx.AsyncClient):
        """
        GIVEN a PATCH that sets a new category and FX default
        WHEN the settings are read back via GET
        THEN the GET reflects the values the PATCH committed
        """
        # WHEN — write through PATCH.
        await client.patch(
            SETTINGS,
            json={"monotributoCurrentCategory": "K", "fxDefaultRateType": "official"},
        )

        # THEN — the subsequent GET sees the committed values.
        data = (await client.get(SETTINGS)).json()["data"]
        assert data["monotributoCurrentCategory"] == "K"
        assert data["fxDefaultRateType"] == "official"

    async def test_preferred_rate_source_round_trips(self, client: httpx.AsyncClient):
        """
        GIVEN a new user whose preferred rate source defaults to 'bolsa' (ADR-151)
        WHEN a PATCH sets it to 'oficial'
        THEN the PATCH echoes it and a later GET reflects the committed value
        """
        # WHEN — change only the preferred rate source.
        patched = await client.patch(SETTINGS, json={"preferredRateSource": "oficial"})

        # THEN — the PATCH echoes it and the subsequent GET sees it committed.
        assert patched.status_code == status.HTTP_200_OK
        assert patched.json()["data"]["preferredRateSource"] == "oficial"
        data = (await client.get(SETTINGS)).json()["data"]
        assert data["preferredRateSource"] == "oficial"

    async def test_enabling_monotributo_round_trips(self, client: httpx.AsyncClient):
        """
        GIVEN a new user with the Monotributo module off by default (ADR-126)
        WHEN a PATCH enables the module
        THEN the PATCH echoes monotributoEnabled true and a later GET reflects it
        """
        # WHEN — enable the optional module via PATCH.
        patched = await client.patch(SETTINGS, json={"monotributoEnabled": True})

        # THEN — the PATCH echoes the toggle, and the subsequent GET sees it committed.
        assert patched.status_code == status.HTTP_200_OK
        assert patched.json()["data"]["monotributoEnabled"] is True
        data = (await client.get(SETTINGS)).json()["data"]
        assert data["monotributoEnabled"] is True

    @pytest.mark.parametrize(
        ("body", "label"),
        [
            ({"preferredDisplayCurrency": "EUR"}, "bad currency"),
            ({"fxDefaultRateType": "manual"}, "bad FX default"),
            ({"preferredRateSource": "blue"}, "bad rate source"),
            ({"monotributoCurrentCategory": "Z"}, "bad category"),
        ],
    )
    async def test_invalid_value_returns_422(
        self,
        client: httpx.AsyncClient,
        uow: FakeUnitOfWork,
        body: dict[str, str],
        label: str,
    ):
        """
        GIVEN a PATCH body carrying an unknown {currency, FX default, category}
        WHEN the settings endpoint is patched
        THEN it returns 422 and nothing was committed through the unit of work
        """
        # WHEN
        response = await client.patch(SETTINGS, json=body)

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, label
        assert uow.committed is False
