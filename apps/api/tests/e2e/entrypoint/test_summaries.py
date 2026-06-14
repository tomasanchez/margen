"""Route tests for the monthly summaries entrypoint (ADR-042, ADR-032).

Per ADR-032 these drive the FastAPI app through the ASGI client with the
query-side reader **mocked** to a :class:`FakeSummaryReader` returning a canned
summary. They assert the HTTP contract — the ``{data}`` envelope, camelCase
fields, the default-month behavior and ``422`` on a malformed month — not the
SQL aggregation (the integration tier proves that).
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
from margen_api.entrypoint.dependencies import get_summary_reader
from margen_api.service_layer.summary_read_models import (
    CategorySummary,
    MonthlySummary,
    TrendPoint,
)
from margen_api.settings.database_settings import DatabaseSettings
from tests.fakes.persistence import FakeSummaryReader

SUMMARIES = "/api/v1/summaries"


def _summary() -> MonthlySummary:
    """Build a canned monthly summary covering trend and category shapes."""
    return MonthlySummary(
        month="2026-06",
        trend=[
            TrendPoint(month="2026-05", expenses=Decimal("100.00"), current=False),
            TrendPoint(month="2026-06", expenses=Decimal("250.50"), current=True),
        ],
        categories=[
            CategorySummary(
                category="Food",
                amount=Decimal("250.50"),
                share=Decimal("100"),
                delta_pct=Decimal("150.5"),
            ),
            CategorySummary(
                category="Uncategorized",
                amount=Decimal("0"),
                share=Decimal("0"),
                delta_pct=None,
            ),
        ],
    )


@pytest.fixture(name="reader")
def fixture_reader() -> FakeSummaryReader:
    """Provide a fake summary reader returning a canned summary."""
    return FakeSummaryReader(_summary())


@pytest.fixture(name="client")
async def fixture_client(reader: FakeSummaryReader) -> AsyncIterator[httpx.AsyncClient]:
    """Build an ASGI client whose summary reader dependency is mocked."""
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
    app = get_application(container)
    app.dependency_overrides[get_summary_reader] = lambda: reader

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await container.shutdown()


class TestMonthlySummary:
    """GET /summaries returns the envelope and honors the month param."""

    async def test_returns_envelope_with_trend_and_categories(
        self, client: httpx.AsyncClient, reader: FakeSummaryReader
    ):
        """
        GIVEN a mocked reader returning a canned summary
        WHEN the summaries endpoint is requested for an explicit month
        THEN it returns 200 with the {data} envelope, camelCase fields and the
             requested month parsed to the first of that month
        """
        # WHEN
        response = await client.get(SUMMARIES, params={"month": "2026-06"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["month"] == "2026-06"
        # trend points carry camelCase fields and the current flag.
        assert data["trend"][-1] == {"month": "2026-06", "expenses": "250.50", "current": True}
        # categories carry camelCase deltaPct (null allowed) and share.
        food, uncategorized = data["categories"]
        assert food["category"] == "Food"
        assert food["deltaPct"] == "150.5"
        assert uncategorized["deltaPct"] is None
        # The router parsed the param to the first of the requested month.
        assert reader.requested_month == date(2026, 6, 1)

    async def test_defaults_to_current_server_month(self, client: httpx.AsyncClient, reader: FakeSummaryReader):
        """
        GIVEN no month query param
        WHEN the summaries endpoint is requested
        THEN it returns 200 and the reader is asked for the current server month
        """
        # WHEN
        response = await client.get(SUMMARIES)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        today = datetime.now(UTC).date()
        assert reader.requested_month == date(today.year, today.month, 1)

    @pytest.mark.parametrize("bad_month", ["2026-13", "2026-6", "june", "2026/06", "2026-00"])
    async def test_malformed_month_returns_422(self, client: httpx.AsyncClient, bad_month: str):
        """
        GIVEN a malformed month query param
        WHEN the summaries endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(SUMMARIES, params={"month": bad_month})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
