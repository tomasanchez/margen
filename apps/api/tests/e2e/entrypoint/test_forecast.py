"""Route tests for the cash-flow forecast entrypoint (ADR-176, ADR-177).

Two tiers cover ``GET /reports/forecast``:

* The envelope / contract / validation tier drives the endpoint with the forecast
  reader **mocked** to a :class:`FakeForecastReader` (ADR-032): it asserts the ``{data}``
  envelope, camelCase fields, the horizon/currency forwarding and clamp defaults, and
  the ``422`` boundary validation — not the committed-stream SQL.
* The DB-backed tier drives the **REAL** container on in-memory async SQLite (ADR-019)
  so the ``SqlAlchemyForecastReader`` derives the committed streams for real: recurring
  subscriptions, instalment tails and the monotributo cuota, in both currencies, plus
  owner scoping (a second user's commitments never leak). Movements are dated in the
  CURRENT month (the reader anchors its horizon at ``datetime.now``) so a stream's tail
  starts next month regardless of the run date.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest
from fastapi import status

from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.domain.models.value_objects import Currency
from margen_api.entrypoint.dependencies import get_forecast_reader
from margen_api.service_layer.forecast_read_models import (
    CommitmentLine,
    CommitmentSource,
    ForecastMonth,
    ForecastSeries,
)
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B, STUB_USER_ID

FORECAST = "/api/v1/reports/forecast"
TRANSACTIONS = "/api/v1/transactions"
SETTINGS = "/api/v1/settings"


def _next_month_key() -> str:
    """Return the month AFTER the current server month as ``YYYY-MM`` (the horizon start)."""
    today = datetime.now(UTC).date()
    index = today.year * 12 + today.month  # (year*12 + (month-1)) + 1.
    year, month = divmod(index, 12)
    return f"{year:04d}-{month + 1:02d}"


def _today_iso() -> str:
    """Return today's date as an ISO string for a movement in the current month."""
    return date.today().isoformat()


def _series() -> ForecastSeries:
    """Build a canned forecast exercising every commitment source and the unconverted caveat."""
    return ForecastSeries(
        horizon=3,
        currency="USD",
        months=[
            ForecastMonth(
                month="2026-07", committed=Decimal("160.00"), total=Decimal("160.00"), confidence="committed"
            ),
            ForecastMonth(month="2026-08", committed=Decimal("60.00"), total=Decimal("60.00"), confidence="committed"),
            ForecastMonth(month="2026-09", committed=Decimal("60.00"), total=Decimal("60.00"), confidence="committed"),
        ],
        commitments=[
            CommitmentLine(
                source=CommitmentSource.SUBSCRIPTION,
                label="Netflix",
                amount=Decimal("10.00"),
                currency="USD",
                months=["2026-07", "2026-08", "2026-09"],
            ),
            CommitmentLine(
                source=CommitmentSource.INSTALLMENT,
                label="Fridge",
                amount=Decimal("100.00"),
                currency="USD",
                months=["2026-07"],
                remaining_count=1,
            ),
            CommitmentLine(
                source=CommitmentSource.TAX,
                label="Monotributo",
                amount=Decimal("50.00"),
                currency="USD",
                months=["2026-07", "2026-08", "2026-09"],
            ),
        ],
        unconverted=2,
    )


class TestForecastContract:
    """GET /reports/forecast returns the {data} envelope with the forecast shape (ADR-176)."""

    @pytest.fixture(name="reader")
    def fixture_reader(self):
        """Provide a fake forecast reader returning a canned series."""
        from tests.fakes.persistence import FakeForecastReader

        return FakeForecastReader(_series())

    @pytest.fixture(name="client")
    async def fixture_client(self, reader) -> AsyncIterator[httpx.AsyncClient]:
        """Build an ASGI client whose forecast reader dependency is mocked."""
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
        app = get_application(container)
        app.dependency_overrides[get_forecast_reader] = lambda: reader
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    async def test_returns_envelope_with_months_and_commitments(self, client: httpx.AsyncClient, reader):
        """
        GIVEN a mocked reader returning a canned forecast
        WHEN the forecast endpoint is requested for a 3-month USD horizon
        THEN it returns 200 with the {data} envelope, camelCase months + commitments,
             and forwards the horizon/currency scoped to the authenticated owner
        """
        # WHEN
        response = await client.get(FORECAST, params={"horizon": 3, "currency": "USD"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["horizon"] == 3
        assert data["currency"] == "USD"
        assert data["unconverted"] == 2
        assert data["months"][0] == {
            "month": "2026-07",
            "committed": "160.00",
            "total": "160.00",
            "confidence": "committed",
        }
        commitments = {line["label"]: line for line in data["commitments"]}
        assert commitments["Netflix"]["source"] == "subscription"
        assert commitments["Netflix"]["remainingCount"] is None
        assert commitments["Fridge"]["source"] == "installment"
        assert commitments["Fridge"]["remainingCount"] == 1
        assert commitments["Fridge"]["months"] == ["2026-07"]
        assert commitments["Monotributo"]["source"] == "tax"
        # The router forwards the horizon/currency and scopes to the owner (ADR-108).
        assert reader.requested_horizon == 3
        assert reader.requested_currency == Currency.USD
        assert reader.requested_user_id == STUB_USER_ID

    async def test_defaults_to_six_months_ars(self, client: httpx.AsyncClient, reader):
        """
        GIVEN no horizon or currency query params
        WHEN the forecast endpoint is requested
        THEN it returns 200 and the reader is asked for the default 6-month ARS horizon
        """
        # WHEN
        response = await client.get(FORECAST)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert reader.requested_horizon == 6
        assert reader.requested_currency == Currency.ARS

    @pytest.mark.parametrize("bad_param", [{"horizon": 0}, {"horizon": 13}, {"horizon": -1}, {"currency": "EUR"}])
    async def test_out_of_range_params_return_422(self, client: httpx.AsyncClient, bad_param: dict):
        """
        GIVEN an out-of-range horizon or an out-of-set currency
        WHEN the forecast endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(FORECAST, params=bad_param)

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestForecastDbBacked:
    """The REAL forecast reader derives committed streams on the in-memory tier (ADR-176, ADR-177).

    Drives the endpoint through the real container (no reader override) so the
    ``SqlAlchemyForecastReader`` stream aggregations execute end to end. Movements are
    placed in the CURRENT month so a stream's projected tail starts next month.
    """

    async def _post(self, client: httpx.AsyncClient, **body: object) -> str:
        """POST a transaction dated today, asserting 201, and return its id."""
        payload: dict[str, object] = {"occurredOn": _today_iso(), "name": "Movement"}
        payload.update(body)
        response = await client.post(TRANSACTIONS, json=payload)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        return response.json()["data"]["id"]

    async def test_recurring_and_installment_project_forward_ars(self, test_client: httpx.AsyncClient):
        """
        GIVEN a monthly recurring expense and a 2-remaining instalment plan this month
        WHEN the ARS forecast is read through the real reader
        THEN next month sums both, the instalment tail is bounded, and each surfaces as a
             commitment line (ADR-176)
        """
        # GIVEN — a monthly subscription and an instalment row (2 of 4 → 2 remaining).
        await self._post(
            test_client,
            kind="expense",
            amountNum="1000",
            name="Rent",
            category="Housing",
            recurring=True,
            recurringCadence="monthly",
        )
        await self._post(
            test_client,
            kind="expense",
            amountNum="500",
            name="Fridge",
            category="Home",
            recurringCadence="installment",
            installmentsTotal=4,
            installmentsIndex=2,
        )

        # WHEN
        response = await test_client.get(FORECAST, params={"horizon": 6, "currency": "ARS"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["currency"] == "ARS"
        assert data["unconverted"] == 0
        by_month = {m["month"]: m for m in data["months"]}
        next_month = _next_month_key()
        # Next month: rent 1000 + one instalment cuota 500 = 1500.
        assert by_month[next_month]["committed"] == "1500.00"
        sources = {line["source"] for line in data["commitments"]}
        assert sources == {"subscription", "installment"}
        installment = next(line for line in data["commitments"] if line["source"] == "installment")
        assert installment["remainingCount"] == 2
        assert len(installment["months"]) == 2  # 2 remaining payments → a 2-month tail.

    async def test_recurring_without_cadence_defaults_monthly(self, test_client: httpx.AsyncClient):
        """
        GIVEN a flagged recurring expense with NO explicit cadence
        WHEN the ARS forecast is read
        THEN it defaults to monthly and lands in every horizon month (ADR-176)
        """
        # GIVEN
        await self._post(test_client, kind="expense", amountNum="200", name="Water", recurring=True)

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 3, "currency": "ARS"})).json()["data"]

        # THEN
        assert all(m["committed"] == "200.00" for m in data["months"])
        (line,) = data["commitments"]
        assert line["source"] == "subscription"
        assert len(line["months"]) == 3

    async def test_installment_without_structured_fields_projects_nothing(self, test_client: httpx.AsyncClient):
        """
        GIVEN an installment-cadence expense with NO structured total/index (a lone marker)
        WHEN the forecast is read
        THEN it produces no tail — the plan has no known remaining count (ADR-176)
        """
        # GIVEN — cadence set but no total/index recovered.
        await self._post(
            test_client, kind="expense", amountNum="500", name="Mystery plan", recurringCadence="installment"
        )

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 3, "currency": "ARS"})).json()["data"]

        # THEN
        assert all(m["committed"] == "0.00" for m in data["months"])
        assert data["commitments"] == []

    async def test_usd_excludes_snapshotless_recurring_and_counts_unconverted(self, test_client: httpx.AsyncClient):
        """
        GIVEN one recurring expense WITH a USD snapshot and one WITHOUT
        WHEN the USD forecast is read
        THEN the snapshotted stream projects on its usd_amount, the snapshotless one is
             excluded and surfaced in unconverted (ADR-152, ADR-168)
        """
        # GIVEN — a snapshotted recurring (usd=20 @ rate 1000) and a snapshotless one.
        await self._post(
            test_client,
            kind="expense",
            amountNum="20000",
            currency="USD",
            usd="20",
            rate="1000",
            name="Cloud",
            recurring=True,
            recurringCadence="monthly",
        )
        await self._post(test_client, kind="expense", amountNum="5000", name="Local sub", recurring=True)

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 2, "currency": "USD"})).json()["data"]

        # THEN
        assert data["currency"] == "USD"
        assert data["unconverted"] == 1
        # Only the snapshotted stream projects; each month is its usd_amount 20.00.
        assert all(m["committed"] == "20.00" for m in data["months"])
        assert [line["label"] for line in data["commitments"]] == ["Cloud"]

    async def test_monotributo_cuota_included_when_configured(self, test_client: httpx.AsyncClient):
        """
        GIVEN a configured monotributo category (services)
        WHEN the ARS forecast is read with no other commitments
        THEN the configured category's monthly cuota lands in every horizon month as a
             tax commitment (ADR-177)
        """
        # GIVEN — configure category A / services via the real settings write path.
        patched = await test_client.patch(
            SETTINGS,
            json={"monotributoCurrentCategory": "A", "monotributoActivityType": "services"},
        )
        assert patched.status_code == status.HTTP_200_OK, patched.text

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 2, "currency": "ARS"})).json()["data"]

        # THEN — every month carries the A/services cuota; a single tax commitment spans it.
        tax = next(line for line in data["commitments"] if line["source"] == "tax")
        assert tax["label"] == "Monotributo"
        assert len(tax["months"]) == 2
        cuota = Decimal(tax["amount"])
        assert cuota > Decimal(0)
        assert all(Decimal(m["committed"]) == cuota for m in data["months"])

    async def test_monotributo_bienes_uses_goods_cuota(self, test_client: httpx.AsyncClient):
        """
        GIVEN a configured monotributo category with the goods (bienes) activity type
        WHEN the ARS forecast is read
        THEN the goods cuota column is used (ADR-046, ADR-177)
        """
        # GIVEN
        patched = await test_client.patch(
            SETTINGS,
            json={"monotributoCurrentCategory": "H", "monotributoActivityType": "bienes"},
        )
        assert patched.status_code == status.HTTP_200_OK, patched.text

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 1, "currency": "ARS"})).json()["data"]

        # THEN — a positive goods cuota lands.
        tax = next(line for line in data["commitments"] if line["source"] == "tax")
        assert Decimal(tax["amount"]) > Decimal(0)

    async def test_no_config_omits_the_tax_leg(self, test_client: httpx.AsyncClient):
        """
        GIVEN no configured monotributo category (no app_settings row)
        WHEN the forecast is read
        THEN there is no tax commitment (ADR-177)
        """
        # WHEN — no settings written for this fresh user.
        data = (await test_client.get(FORECAST, params={"horizon": 3, "currency": "ARS"})).json()["data"]

        # THEN
        assert all(line["source"] != "tax" for line in data["commitments"])

    async def test_same_name_category_collapses_to_one_stream(self, test_client: httpx.AsyncClient):
        """
        GIVEN two recurring rows sharing the same (name, category) — an older and a newer
        WHEN the forecast is read
        THEN they collapse to ONE stream keyed off the LATEST occurrence's amount (ADR-176)
        """
        # GIVEN — two "Rent"/"Housing" rows; the newer (300) is the latest occurrence.
        today = date.today()
        older = today.replace(day=1).isoformat()
        newer = today.replace(day=min(28, today.day)).isoformat()
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": older,
                "name": "Rent",
                "kind": "expense",
                "amountNum": "100",
                "category": "Housing",
                "recurring": True,
                "recurringCadence": "monthly",
            },
        )
        await test_client.post(
            TRANSACTIONS,
            json={
                "occurredOn": newer,
                "name": "Rent",
                "kind": "expense",
                "amountNum": "300",
                "category": "Housing",
                "recurring": True,
                "recurringCadence": "monthly",
            },
        )

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 2, "currency": "ARS"})).json()["data"]

        # THEN — one subscription line at the latest amount (300), not two.
        subs = [line for line in data["commitments"] if line["source"] == "subscription"]
        assert len(subs) == 1
        assert subs[0]["amount"] == "300.00"

    async def test_installment_usd_without_snapshot_is_excluded_and_counted(self, test_client: httpx.AsyncClient):
        """
        GIVEN an instalment plan WITHOUT a USD snapshot
        WHEN the USD forecast is read
        THEN its tail is excluded from the sums and it is surfaced in unconverted
             (ADR-152, ADR-168)
        """
        # GIVEN — an instalment (2 remaining) with no usd_amount snapshot.
        await self._post(
            test_client,
            kind="expense",
            amountNum="5000",
            name="ARS plan",
            category="Home",
            recurringCadence="installment",
            installmentsTotal=4,
            installmentsIndex=2,
        )

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 3, "currency": "USD"})).json()["data"]

        # THEN — nothing projected (excluded), but the exclusion is counted.
        assert data["unconverted"] == 1
        assert all(m["committed"] == "0.00" for m in data["months"])
        assert data["commitments"] == []

    async def test_installment_same_name_category_collapses_to_one_plan(self, test_client: httpx.AsyncClient):
        """
        GIVEN two instalment rows sharing the same (name, category) — an older and a newer
        WHEN the forecast is read
        THEN they collapse to ONE plan keyed off the LATEST occurrence (ADR-176)
        """
        # GIVEN — two "Sofa"/"Home" instalment rows; the newer (cuota 4/6) is latest.
        today = date.today()
        older = today.replace(day=1).isoformat()
        newer = today.replace(day=min(28, today.day)).isoformat()
        for occurred, index in ((older, 3), (newer, 4)):
            response = await test_client.post(
                TRANSACTIONS,
                json={
                    "occurredOn": occurred,
                    "name": "Sofa",
                    "kind": "expense",
                    "amountNum": "800",
                    "category": "Home",
                    "recurringCadence": "installment",
                    "installmentsTotal": 6,
                    "installmentsIndex": index,
                },
            )
            assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        data = (await test_client.get(FORECAST, params={"horizon": 6, "currency": "ARS"})).json()["data"]

        # THEN — one instalment line with the latest plan's remaining count (6 - 4 = 2).
        plans = [line for line in data["commitments"] if line["source"] == "installment"]
        assert len(plans) == 1
        assert plans[0]["remainingCount"] == 2

    async def test_user_b_forecast_excludes_user_a_commitments(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A has a recurring commitment this month
        WHEN user B reads the forecast
        THEN B's forecast is empty — A's commitments never leak (ADR-108, ADR-131)
        """
        # GIVEN — user A creates a recurring expense.
        await self._post(
            test_client, kind="expense", amountNum="900", name="A rent", recurring=True, recurringCadence="monthly"
        )

        # WHEN / THEN — user B sees none of A's commitments.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.get(FORECAST, params={"horizon": 3, "currency": "ARS"})
            assert response.status_code == status.HTTP_200_OK
            data = response.json()["data"]
            assert data["commitments"] == []
            assert all(m["committed"] == "0.00" for m in data["months"])
