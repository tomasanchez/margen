"""Route tests for the transaction entrypoint (ADR-030, ADR-032).

Per ADR-032 these drive the FastAPI app through the ASGI test client with the
persistence dependencies **mocked**: ``get_bus`` resolves a real
:class:`MessageBus` whose unit-of-work factory returns an in-memory
:class:`FakeUnitOfWork`, and ``get_transaction_reader`` resolves a
:class:`FakeTransactionReader` over the same committed store. No SQLite, no
Postgres — these assert the wiring and the HTTP contract, not real SQL.
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
from margen_api.bootstrap import bootstrap
from margen_api.domain.models.exceptions import InvalidAmountError, UnknownKindError
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Kind
from margen_api.entrypoint.dependencies import get_bus, get_transaction_reader
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_USER_ID
from tests.fakes.persistence import FakeTransactionReader, FakeUnitOfWork

TRANSACTIONS = "/api/v1/transactions"
A_DATE = "2026-06-12"


@pytest.fixture(name="uow")
def fixture_uow() -> FakeUnitOfWork:
    """Provide a single shared in-memory unit of work for the app under test."""
    return FakeUnitOfWork()


@pytest.fixture(name="client")
async def fixture_client(uow: FakeUnitOfWork) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose persistence dependencies are mocked.

    The message bus is real (so commands flow through the registered handlers)
    but its unit of work is the shared :class:`FakeUnitOfWork`; the reader reads
    that same committed store. The container is bootstrapped on in-memory SQLite
    only to satisfy ``get_application``; its engine is never touched because both
    persistence dependencies are overridden.
    """
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)

    bus = MessageBus(
        uow_factory=lambda: uow,
        command_handlers=dict(COMMAND_HANDLERS),
        event_handlers={event: list(handlers) for event, handlers in EVENT_HANDLERS.items()},
    )
    reader = FakeTransactionReader(uow.committed_aggregates)

    app.dependency_overrides[get_bus] = lambda: bus
    app.dependency_overrides[get_transaction_reader] = lambda: reader

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await container.shutdown()


def _seed(uow: FakeUnitOfWork, **overrides: object):
    """Place a committed aggregate directly in the shared store."""
    defaults: dict[str, object] = {
        "occurred_on": date(2026, 6, 12),
        "name": "Apartment rent",
        "kind": Kind.EXPENSE,
        "amount": Decimal("1000"),
        "transaction_id": uuid4(),
        "user_id": STUB_USER_ID,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    defaults.update(overrides)
    transaction = build_transaction(**defaults)  # type: ignore[arg-type]
    uow.committed_aggregates[transaction.id] = transaction
    return transaction


class TestListTransactions:
    """GET /transactions returns the response envelope, newest-first."""

    async def test_returns_newest_first(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN two committed transactions on different dates
        WHEN the list endpoint is requested
        THEN it returns 200 with the newer transaction first
        """
        # GIVEN
        _seed(uow, name="Older", occurred_on=date(2026, 6, 1))
        _seed(uow, name="Newer", occurred_on=date(2026, 6, 20))

        # WHEN
        response = await client.get(TRANSACTIONS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert [row["name"] for row in data] == ["Newer", "Older"]

    async def test_empty_list(self, client: httpx.AsyncClient):
        """
        GIVEN no committed transactions
        WHEN the list endpoint is requested
        THEN it returns 200 with an empty data list
        """
        # WHEN
        response = await client.get(TRANSACTIONS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"] == []


class TestCreateTransaction:
    """POST /transactions dispatches a create command and returns the entity."""

    async def test_creates_and_returns_201(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a valid create body
        WHEN the create endpoint is posted
        THEN it returns 201 with the persisted entity and stores the aggregate
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "name": "Coto", "kind": "expense", "amountNum": "1500.00"},
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()["data"]
        assert body["name"] == "Coto"
        assert body["type"] == "expense"
        # The handler actually persisted the aggregate through the fake unit of work.
        assert len(uow.committed_aggregates) == 1

    async def test_usd_without_rate_is_accepted(self, client: httpx.AsyncClient):
        """
        GIVEN a USD create body with no rate
        WHEN the create endpoint is posted
        THEN it returns 201 (USD without a rate is accepted, ADR-031)
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={
                "occurredOn": A_DATE,
                "name": "MacBook",
                "kind": "expense",
                "amountNum": "1000000",
                "currency": "USD",
                "usd": "1000",
            },
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["data"]["currency"] == "USD"

    async def test_non_positive_amount_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a create body with a non-positive amount
        WHEN the create endpoint is posted
        THEN Pydantic boundary validation returns 422
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "name": "Coto", "kind": "expense", "amountNum": "0"},
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_missing_name_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a create body without a name
        WHEN the create endpoint is posted
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "kind": "expense", "amountNum": "100"},
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_unknown_kind_returns_422(self, client: httpx.AsyncClient):
        """
        GIVEN a create body with an unknown kind
        WHEN the create endpoint is posted
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "name": "Coto", "kind": "transfer", "amountNum": "100"},
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestDomainInvariantToHttp:
    """A domain invariant surfacing from the bus maps to 422 (ADR-031).

    Pydantic catches the obvious violations at the boundary, so to exercise the
    router's handler-level translation we drive the app with a bus whose
    ``handle`` raises the domain exception directly.
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
        app.dependency_overrides[get_transaction_reader] = lambda: FakeTransactionReader({})

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    @pytest.mark.parametrize(
        "raising_client",
        [InvalidAmountError(Decimal("-1")), UnknownKindError("transfer")],
        indirect=True,
    )
    async def test_create_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose create handler raises a domain invariant violation
        WHEN a syntactically valid create body is posted
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.post(
            TRANSACTIONS,
            json={"occurredOn": A_DATE, "name": "Coto", "kind": "expense", "amountNum": "100"},
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.parametrize(
        "raising_client",
        [InvalidAmountError(Decimal("-1")), UnknownKindError("transfer")],
        indirect=True,
    )
    async def test_update_maps_invariant_to_422(self, raising_client: httpx.AsyncClient):
        """
        GIVEN a bus whose update handler raises a domain invariant violation
        WHEN a syntactically valid patch is sent
        THEN the router maps it to 422
        """
        # WHEN
        response = await raising_client.patch(f"{TRANSACTIONS}/{uuid4()}", json={"name": "Coto"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestGetTransaction:
    """GET /transactions/{id} returns 200 or 404."""

    async def test_returns_200_when_found(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a committed transaction
        WHEN it is fetched by id
        THEN it returns 200 with the entity
        """
        # GIVEN
        transaction = _seed(uow)

        # WHEN
        response = await client.get(f"{TRANSACTIONS}/{transaction.id}")

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["id"] == str(transaction.id)

    async def test_returns_404_when_absent(self, client: httpx.AsyncClient):
        """
        GIVEN no transaction for an id
        WHEN it is fetched by id
        THEN it returns 404
        """
        # WHEN
        response = await client.get(f"{TRANSACTIONS}/{uuid4()}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestUpdateTransaction:
    """PATCH /transactions/{id} returns 200 or 404."""

    async def test_patches_and_returns_200(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a committed transaction
        WHEN a patch changes its name
        THEN it returns 200 with the refreshed entity
        """
        # GIVEN
        transaction = _seed(uow, name="Original")

        # WHEN
        response = await client.patch(f"{TRANSACTIONS}/{transaction.id}", json={"name": "Updated"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["name"] == "Updated"

    async def test_missing_id_returns_404(self, client: httpx.AsyncClient):
        """
        GIVEN no transaction for an id
        WHEN a patch is sent
        THEN the handler's TransactionNotFoundError maps to 404
        """
        # WHEN
        response = await client.patch(f"{TRANSACTIONS}/{uuid4()}", json={"name": "ghost"})

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestDeleteTransaction:
    """DELETE /transactions/{id} returns 204 or 404."""

    async def test_deletes_and_returns_204(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a committed transaction
        WHEN it is deleted
        THEN it returns 204 and the aggregate is gone
        """
        # GIVEN
        transaction = _seed(uow)

        # WHEN
        response = await client.delete(f"{TRANSACTIONS}/{transaction.id}")

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert transaction.id not in uow.committed_aggregates

    async def test_missing_id_returns_404(self, client: httpx.AsyncClient):
        """
        GIVEN no transaction for an id
        WHEN a delete is sent
        THEN the handler's TransactionNotFoundError maps to 404
        """
        # WHEN
        response = await client.delete(f"{TRANSACTIONS}/{uuid4()}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND


# A second tenant whose rows the authenticated stub user must never see or touch.
OTHER_USER_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678"


class TestCrossTenantIsolation:
    """Another user's transaction is invisible and a 404 across by-id paths (ADR-108, ADR-111)."""

    async def test_list_excludes_other_users_rows(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN one row owned by the stub user and one owned by another user
        WHEN the authenticated stub user lists transactions
        THEN only its own row is returned (ownership filter, ADR-108)
        """
        # GIVEN
        mine = _seed(uow, name="Mine")
        _seed(uow, name="Theirs", user_id=OTHER_USER_ID)

        # WHEN
        response = await client.get(TRANSACTIONS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        names = [row["name"] for row in response.json()["data"]]
        assert names == ["Mine"]
        assert str(mine.id) in {row["id"] for row in response.json()["data"]}

    async def test_get_other_users_row_returns_404(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a row owned by another user
        WHEN the stub user fetches it by id
        THEN it returns 404 (existence is never leaked, ADR-111)
        """
        # GIVEN
        theirs = _seed(uow, name="Theirs", user_id=OTHER_USER_ID)

        # WHEN
        response = await client.get(f"{TRANSACTIONS}/{theirs.id}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_patch_other_users_row_returns_404(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a row owned by another user
        WHEN the stub user patches it
        THEN it returns 404 and the row is left untouched (ADR-111)
        """
        # GIVEN
        theirs = _seed(uow, name="Theirs", user_id=OTHER_USER_ID)

        # WHEN
        response = await client.patch(f"{TRANSACTIONS}/{theirs.id}", json={"name": "Hijacked"})

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert uow.committed_aggregates[theirs.id].name == "Theirs"

    async def test_delete_other_users_row_returns_404(self, client: httpx.AsyncClient, uow: FakeUnitOfWork):
        """
        GIVEN a row owned by another user
        WHEN the stub user deletes it
        THEN it returns 404 and the row still exists (ADR-111)
        """
        # GIVEN
        theirs = _seed(uow, name="Theirs", user_id=OTHER_USER_ID)

        # WHEN
        response = await client.delete(f"{TRANSACTIONS}/{theirs.id}")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert theirs.id in uow.committed_aggregates
