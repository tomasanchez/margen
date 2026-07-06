"""Route tests for the monthly insights entrypoint (ADR-060, ADR-061, ADR-032).

Per ADR-032 these drive the FastAPI app through the ASGI client with the
query-side reader **mocked** to a :class:`FakeInsightsReader` returning canned
structured facts. They assert the HTTP contract — the ``{data}`` envelope,
camelCase fields, Decimal-string money, ``null`` for absent optional facts, the
default-month behavior and ``422`` on a malformed month — not the SQL
aggregation (the integration tier proves that).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import bootstrap
from margen_api.entrypoint.dependencies import get_insights_reader
from margen_api.service_layer.insights_read_models import (
    LatestUsdInvoice,
    MonthlyInsights,
    RecurringExpenses,
    Savings,
    TopCategoryMover,
    UpcomingCardDue,
)
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_USER_ID
from tests.fakes.persistence import FakeInsightsReader

INSIGHTS = "/api/v1/insights"


def _insights() -> MonthlyInsights:
    """Build canned insights covering every populated structured fact."""
    return MonthlyInsights(
        month="2026-06",
        top_category_mover=TopCategoryMover(category="Food", delta_pct=Decimal("150.5")),
        recurring=RecurringExpenses(count=3, total=Decimal("1250.00")),
        savings=Savings(
            amount=Decimal("3000.00"),
            is_projected=True,
            elapsed_fraction=Decimal("0.5"),
        ),
        latest_usd_invoice=LatestUsdInvoice(
            usd=Decimal("100.00"),
            rate=Decimal("1200.50"),
            rate_type="MEP",
            occurred_on=date(2026, 6, 10),
        ),
        upcoming_card_due=[
            UpcomingCardDue(due_date=date(2026, 6, 15), ars=Decimal("50000.00"), usd=Decimal("0")),
            UpcomingCardDue(due_date=date(2026, 6, 17), ars=Decimal("0"), usd=Decimal("120.00")),
        ],
    )


def _empty_insights() -> MonthlyInsights:
    """Build canned insights where every optional fact is absent."""
    return MonthlyInsights(
        month="2026-06",
        top_category_mover=None,
        recurring=None,
        savings=Savings(amount=Decimal("0"), is_projected=False, elapsed_fraction=Decimal("1")),
        latest_usd_invoice=None,
        upcoming_card_due=None,
    )


@pytest.fixture(name="reader")
def fixture_reader() -> FakeInsightsReader:
    """Provide a fake insights reader returning canned facts."""
    return FakeInsightsReader(_insights())


@pytest.fixture(name="client")
async def fixture_client(reader: FakeInsightsReader) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose insights reader dependency is mocked."""
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)
    app.dependency_overrides[get_insights_reader] = lambda: reader

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await container.shutdown()


class TestMonthlyInsights:
    """GET /insights returns the envelope and honors the month param."""

    async def test_returns_envelope_with_structured_facts(self, client: httpx.AsyncClient, reader: FakeInsightsReader):
        """
        GIVEN a mocked reader returning canned insight facts
        WHEN the insights endpoint is requested for an explicit month
        THEN it returns 200 with the {data} envelope, camelCase fields, Decimal
             string money, and the requested month parsed to the first of that month
        """
        # WHEN
        response = await client.get(INSIGHTS, params={"month": "2026-06"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["month"] == "2026-06"
        # Top mover carries camelCase deltaPct as a Decimal string.
        assert data["topCategoryMover"] == {"category": "Food", "deltaPct": "150.5"}
        # Recurring carries the count and a Decimal-string total.
        assert data["recurring"] == {"count": 3, "total": "1250.00"}
        # Savings carries Decimal-string money and the projection flags (camelCase).
        savings = data["savings"]
        assert savings["amount"] == "3000.00"
        assert savings["isProjected"] is True
        assert savings["elapsedFraction"] == "0.5"
        # Latest USD invoice carries Decimal-string money, the rate type and the date.
        assert data["latestUsdInvoice"] == {
            "usd": "100.00",
            "rate": "1200.50",
            "rateType": "MEP",
            "occurredOn": "2026-06-10",
        }
        # Upcoming card dues: one entry per due date ascending, camelCase dueDate and
        # native per-currency Decimal-string totals (0 for the currency with no charge).
        assert data["upcomingCardDue"] == [
            {"dueDate": "2026-06-15", "ars": "50000.00", "usd": "0"},
            {"dueDate": "2026-06-17", "ars": "0", "usd": "120.00"},
        ]
        # The router parsed the param to the first of the requested month.
        assert reader.requested_month == date(2026, 6, 1)

    async def test_absent_facts_serialize_as_null(self, reader: FakeInsightsReader):
        """
        GIVEN a month whose optional facts do not exist
        WHEN the insights endpoint is requested
        THEN the absent optional facts serialize as null and savings are present
        """
        # GIVEN — a client backed by an empty-insights reader.
        reader = FakeInsightsReader(_empty_insights())
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
        app = get_application(container)
        app.dependency_overrides[get_insights_reader] = lambda: reader
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # WHEN
            response = await client.get(INSIGHTS, params={"month": "2026-06"})
        await container.shutdown()

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["topCategoryMover"] is None
        assert data["recurring"] is None
        assert data["latestUsdInvoice"] is None
        assert data["upcomingCardDue"] is None
        assert data["savings"]["amount"] == "0"
        assert data["savings"]["isProjected"] is False

    async def test_defaults_to_current_server_month(self, client: httpx.AsyncClient, reader: FakeInsightsReader):
        """
        GIVEN no month query param
        WHEN the insights endpoint is requested
        THEN it returns 200, the reader is asked for the current server month and a
             reference of the current server date drives the projection
        """
        # WHEN
        response = await client.get(INSIGHTS)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        today = datetime.now(UTC).date()
        assert reader.requested_month == date(today.year, today.month, 1)
        assert reader.requested_reference == today

    async def test_scopes_the_read_to_the_authenticated_owner(
        self, client: httpx.AsyncClient, reader: FakeInsightsReader
    ):
        """
        GIVEN an authenticated caller
        WHEN the insights endpoint is requested
        THEN the reader is asked for that caller's id, so the card dues (and every other
             fact) can only ever be the caller's own — never a foreign owner's (ADR-108)
        """
        # WHEN
        response = await client.get(INSIGHTS, params={"month": "2026-06"})

        # THEN — the boundary threads the authenticated owner into the owner-scoped read.
        assert response.status_code == status.HTTP_200_OK
        assert reader.requested_user_id == STUB_USER_ID

    @pytest.mark.parametrize("bad_month", ["2026-13", "2026-6", "june", "2026/06", "2026-00"])
    async def test_malformed_month_returns_422(self, client: httpx.AsyncClient, bad_month: str):
        """
        GIVEN a malformed month query param
        WHEN the insights endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(INSIGHTS, params={"month": bad_month})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
