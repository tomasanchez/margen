"""Route tests for the Monotributo entrypoint (ADR-046, ADR-052, ADR-032).

Per ADR-032 these drive the FastAPI app through the ASGI client **fully mocked**:
``get_monotributo_reader`` resolves a :class:`FakeMonotributoReader` returning a
canned snapshot, and ``get_bus`` resolves a real :class:`MessageBus` whose unit of
work is an in-memory :class:`FakeUnitOfWork`. No SQLite, no Postgres — these assert
the HTTP contract (the ``{data}`` envelope, camelCase, Decimal-string money, the
``{ current, previous, scale, invoices }`` shape) and the read-records / config
wiring (the capture command and config write actually flow through the fake UoW),
not the SQL aggregation (the integration tier proves that).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.entrypoint.dependencies import get_bus, get_monotributo_reader
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.monotributo import build_standing, scale_entries, trailing_window
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoSnapshot,
    MonotributoStanding,
)
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.settings.database_settings import DatabaseSettings
from tests.fakes.persistence import FakeMonotributoReader, FakeUnitOfWork

MONOTRIBUTO = "/api/v1/monotributo"
TODAY = date(2026, 6, 14)


def _standing(*, used: str, reference: date = TODAY) -> MonotributoStanding:
    """Build a current/previous standing fixture for the canned snapshot."""
    window_start, window_end = trailing_window(reference)
    return build_standing(
        used=Decimal(used),
        category="A",
        activity_type="services",
        window_start=window_start,
        window_end=window_end,
        reference=reference,
    )


def _snapshot(*, with_previous: bool) -> MonotributoSnapshot:
    """Build a canned snapshot, optionally carrying a previous standing."""
    invoices = [
        MonotributoInvoice(
            id=uuid4(),
            occurred_on=date(2026, 1, 15),
            name="Consulting invoice",
            category="Consulting",
            amount=Decimal("1500000.50"),
            currency="ARS",
            cumulative=Decimal("1500000.50"),
            is_foreign_currency=False,
        ),
    ]
    previous = _standing(used="500000.00") if with_previous else None
    return MonotributoSnapshot(
        current=_standing(used="1500000.50"),
        previous=previous,
        scale=scale_entries(),  # full A-K scale so the response mapping is exercised.
        invoices=invoices,
    )


@pytest.fixture(name="uow")
def fixture_uow() -> FakeUnitOfWork:
    """Provide a single shared in-memory unit of work for the app under test."""
    return FakeUnitOfWork()


@pytest.fixture(name="reader")
def fixture_reader() -> FakeMonotributoReader:
    """Provide a fake Monotributo reader returning a snapshot with a previous."""
    return FakeMonotributoReader(_snapshot(with_previous=True))


def _build_client(uow: FakeUnitOfWork, reader: FakeMonotributoReader) -> tuple[httpx.AsyncClient, ApplicationContainer]:
    """Build an ASGI app whose bus + reader dependencies are mocked.

    The bus is real (commands flow through the registered handlers) but its unit
    of work is the shared :class:`FakeUnitOfWork`; the container is bootstrapped on
    in-memory SQLite only to satisfy ``get_application`` — its engine is never
    touched because both persistence dependencies are overridden.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)

    bus = MessageBus(
        uow_factory=lambda: uow,
        command_handlers=dict(COMMAND_HANDLERS),
        event_handlers={event: list(handlers) for event, handlers in EVENT_HANDLERS.items()},
    )
    app.dependency_overrides[get_bus] = lambda: bus
    app.dependency_overrides[get_monotributo_reader] = lambda: reader

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test"), container


@pytest.fixture(name="client")
async def fixture_client(uow: FakeUnitOfWork, reader: FakeMonotributoReader) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose bus + Monotributo reader are mocked."""
    client, container = _build_client(uow, reader)
    async with client:
        yield client
    await container.shutdown()


class TestMonotributoSnapshot:
    """GET /monotributo returns the envelope and records the snapshot (ADR-052)."""

    async def test_returns_envelope_with_full_shape(self, client: httpx.AsyncClient, reader: FakeMonotributoReader):
        """
        GIVEN a mocked reader returning a canned snapshot with a previous standing
        WHEN the Monotributo endpoint is requested
        THEN it returns 200 with the {data} envelope carrying current, previous,
             scale and invoices in camelCase with Decimal-string money
        """
        # WHEN
        response = await client.get(MONOTRIBUTO)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert set(data) == {"current", "previous", "scale", "invoices"}
        # The A-K scale crosses the boundary in camelCase with Decimal-string money.
        assert {row["letter"] for row in data["scale"]} >= {"A", "K"}
        assert "annualCeiling" in data["scale"][0]
        assert isinstance(data["scale"][0]["cuotaServicios"], str)
        # Money is serialized as a Decimal string, not a float.
        assert data["current"]["used"] == "1500000.50"
        assert data["current"]["percentUsed"] == str(_snapshot(with_previous=True).current.percent_used)
        # camelCase keys cross the JSON boundary.
        assert "projectedCategory" in data["current"]
        assert "periodStart" in data["current"]
        # The invoice drilldown carries camelCase and Decimal-string money.
        invoice = data["invoices"][0]
        assert invoice["amount"] == "1500000.50"
        assert invoice["cumulative"] == "1500000.50"
        assert invoice["isForeignCurrency"] is False
        # The reader was asked for the server "today" reference.
        assert reader.requested_reference == datetime.now(UTC).date()

    async def test_previous_present(self, client: httpx.AsyncClient):
        """
        GIVEN a snapshot that carries a previous standing
        WHEN the Monotributo endpoint is requested
        THEN previous is a populated standing object
        """
        # WHEN
        response = await client.get(MONOTRIBUTO)

        # THEN
        previous = response.json()["data"]["previous"]
        assert previous is not None
        assert previous["used"] == "500000.00"

    async def test_previous_may_be_null(self, uow: FakeUnitOfWork):
        """
        GIVEN a snapshot with no prior-window data
        WHEN the Monotributo endpoint is requested
        THEN previous is serialized as null
        """
        # GIVEN
        reader = FakeMonotributoReader(_snapshot(with_previous=False))
        client, container = _build_client(uow, reader)

        # WHEN
        async with client:
            response = await client.get(MONOTRIBUTO)
        await container.shutdown()

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["previous"] is None

    async def test_records_the_capture_command(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a mocked reader and a fake unit of work
        WHEN the Monotributo endpoint is requested (a "read that records")
        THEN the capture command is dispatched and a snapshot is UPSERTed for the
             current period through the unit of work (no real SQL)
        """
        # WHEN
        response = await client.get(MONOTRIBUTO)

        # THEN — the read-records capture committed a snapshot for the current month.
        assert response.status_code == status.HTTP_200_OK
        assert uow.committed is True
        today = datetime.now(UTC).date()
        # The current period is always (re)captured through the unit of work.
        assert date(today.year, today.month, 1) in uow.snapshots


class TestCaptureMonotributo:
    """POST /monotributo/capture acknowledges and records (ADR-052)."""

    async def test_returns_202_captured(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a fake unit of work
        WHEN the capture endpoint is posted
        THEN it returns 202 with status 'captured' and the capture committed a
             snapshot for the current period through the unit of work
        """
        # WHEN
        response = await client.post(f"{MONOTRIBUTO}/capture")

        # THEN
        assert response.status_code == status.HTTP_202_ACCEPTED
        assert response.json()["data"]["status"] == "captured"
        # The command flowed through the bus and committed via the fake UoW.
        assert uow.committed is True
        today = datetime.now(UTC).date()
        assert date(today.year, today.month, 1) in uow.snapshots


class TestUpdateMonotributoConfig:
    """PATCH /monotributo/config writes the config and echoes it back (ADR-048)."""

    async def test_patches_and_returns_200(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a valid config body
        WHEN the config endpoint is patched
        THEN it returns 200 echoing the saved category/activity and the write went
             through the fake unit of work
        """
        # WHEN
        response = await client.patch(
            f"{MONOTRIBUTO}/config",
            json={"currentCategory": "h", "activityType": "bienes"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        # The handler normalizes the letter to uppercase.
        assert data["currentCategory"] == "H"
        assert data["activityType"] == "bienes"
        # The write went through the fake unit of work's config repository.
        assert uow.config == {"current_category": "H", "activity_type": "bienes"}
        assert uow.committed is True

    async def test_activity_omitted_leaves_it_unchanged(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN an existing config and a body without activityType
        WHEN the config endpoint is patched
        THEN the persisted activity is left unchanged
        """
        # GIVEN — a prior activity already persisted.
        uow.config.update({"current_category": "A", "activity_type": "bienes"})

        # WHEN
        response = await client.patch(f"{MONOTRIBUTO}/config", json={"currentCategory": "C"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currentCategory"] == "C"
        assert data["activityType"] == "bienes"

    async def test_unknown_category_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a body with an unknown category letter
        WHEN the config endpoint is patched
        THEN the handler's UnknownCategoryError maps to 422 (ADR-030)
        """
        # WHEN
        response = await client.patch(f"{MONOTRIBUTO}/config", json={"currentCategory": "Z"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_missing_category_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a body without currentCategory
        WHEN the config endpoint is patched
        THEN Pydantic boundary validation returns 422
        """
        # WHEN
        response = await client.patch(f"{MONOTRIBUTO}/config", json={"activityType": "services"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_blank_category_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a body with a blank currentCategory
        WHEN the config endpoint is patched
        THEN min-length boundary validation returns 422
        """
        # WHEN
        response = await client.patch(f"{MONOTRIBUTO}/config", json={"currentCategory": ""})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
