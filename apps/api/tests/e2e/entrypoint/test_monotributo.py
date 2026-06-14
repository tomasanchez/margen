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
from margen_api.entrypoint.dependencies import get_bus, get_monotributo_reader, get_settings
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.monotributo import build_standing, scale_entries, trailing_window
from margen_api.service_layer.monotributo_read_models import (
    MonotributoInvoice,
    MonotributoSnapshot,
    MonotributoStanding,
)
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.settings.api_settings import ApplicationSettings
from margen_api.settings.database_settings import DatabaseSettings
from tests.fakes.persistence import FakeMonotributoReader, FakeUnitOfWork

MONOTRIBUTO = "/api/v1/monotributo"
TODAY = date(2026, 6, 14)
# Shared-secret capture token used by the guarded-endpoint tests (ADR-064).
CAPTURE_TOKEN = "s3cr3t-capture-token"  # noqa: S105 — test fixture, not a real secret


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


def _build_client(
    uow: FakeUnitOfWork,
    reader: FakeMonotributoReader,
    *,
    capture_token: str | None = CAPTURE_TOKEN,
) -> tuple[httpx.AsyncClient, ApplicationContainer]:
    """Build an ASGI app whose bus + reader dependencies are mocked.

    The bus is real (commands flow through the registered handlers) but its unit
    of work is the shared :class:`FakeUnitOfWork`; the container is bootstrapped on
    in-memory SQLite only to satisfy ``get_application`` — its engine is never
    touched because both persistence dependencies are overridden.

    The ``get_settings`` dependency is overridden with an explicitly-constructed
    :class:`ApplicationSettings` so the capture token is deterministic and never
    leaks across tests via the ``lru_cache`` (ADR-064/ADR-066). Pass
    ``capture_token=None`` to exercise the unconfigured/disabled path.
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
    app.dependency_overrides[get_settings] = lambda: ApplicationSettings(MONOTRIBUTO_CAPTURE_TOKEN=capture_token)

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
        GIVEN a fake unit of work and a configured capture token
        WHEN the capture endpoint is posted with the correct bearer token
        THEN it returns 202 with status 'captured' and the capture committed a
             snapshot for the current period through the unit of work
        """
        # WHEN
        response = await client.post(
            f"{MONOTRIBUTO}/capture",
            headers={"Authorization": f"Bearer {CAPTURE_TOKEN}"},
        )

        # THEN
        assert response.status_code == status.HTTP_202_ACCEPTED
        assert response.json()["data"]["status"] == "captured"
        # The command flowed through the bus and committed via the fake UoW.
        assert uow.committed is True
        today = datetime.now(UTC).date()
        assert date(today.year, today.month, 1) in uow.snapshots


class TestCaptureMonotributoAuthGuard:
    """POST /monotributo/capture is guarded by a shared-secret bearer token (ADR-064)."""

    async def test_returns_503_when_token_not_configured(self, uow: FakeUnitOfWork, reader: FakeMonotributoReader):
        """
        GIVEN no capture token is configured (the fail-closed default)
        WHEN the capture endpoint is posted
        THEN it returns 503 and no capture command is dispatched
        """
        # GIVEN — the endpoint is disabled because the secret is unset.
        client, container = _build_client(uow, reader, capture_token=None)

        # WHEN
        async with client:
            response = await client.post(
                f"{MONOTRIBUTO}/capture",
                headers={"Authorization": f"Bearer {CAPTURE_TOKEN}"},
            )
        await container.shutdown()

        # THEN — fail closed: 503 and nothing flowed through the bus/UoW.
        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        assert uow.committed is False
        assert uow.snapshots == {}

    async def test_returns_401_on_missing_authorization_header(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a configured capture token
        WHEN the capture endpoint is posted with no Authorization header
        THEN it returns 401 and no capture command is dispatched
        """
        # WHEN
        response = await client.post(f"{MONOTRIBUTO}/capture")

        # THEN
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert uow.committed is False
        assert uow.snapshots == {}

    async def test_returns_401_on_malformed_authorization_header(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a configured capture token
        WHEN the capture endpoint is posted with a non-Bearer Authorization header
        THEN it returns 401 and no capture command is dispatched
        """
        # WHEN — Basic scheme is not parsed as bearer credentials.
        response = await client.post(
            f"{MONOTRIBUTO}/capture",
            headers={"Authorization": f"Basic {CAPTURE_TOKEN}"},
        )

        # THEN
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert uow.committed is False
        assert uow.snapshots == {}

    async def test_returns_401_on_mismatched_bearer_token(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a configured capture token
        WHEN the capture endpoint is posted with a wrong bearer token
        THEN it returns 401 and no capture command is dispatched
        """
        # WHEN
        response = await client.post(
            f"{MONOTRIBUTO}/capture",
            headers={"Authorization": "Bearer wrong-token"},
        )

        # THEN
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert uow.committed is False
        assert uow.snapshots == {}

    async def test_dispatches_with_correct_token(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a configured capture token
        WHEN the capture endpoint is posted with the matching bearer token
        THEN it returns 202 and the capture command is dispatched through the UoW
        """
        # WHEN
        response = await client.post(
            f"{MONOTRIBUTO}/capture",
            headers={"Authorization": f"Bearer {CAPTURE_TOKEN}"},
        )

        # THEN — authorized: the command flowed through the bus and committed.
        assert response.status_code == status.HTTP_202_ACCEPTED
        assert uow.committed is True
        today = datetime.now(UTC).date()
        assert date(today.year, today.month, 1) in uow.snapshots
