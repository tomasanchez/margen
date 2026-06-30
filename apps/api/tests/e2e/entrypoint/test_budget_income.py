"""Route tests for the budget-income entrypoint (ADR-139, ADR-143, ADR-032).

Drive the REAL application container on in-memory async SQLite (ADR-019/032) so the
net-income base + household floor are genuinely persisted and round-trip through the
real adapters. User A is the default stub (``STUB_USER_ID``); the isolation check uses
the second stub (``STUB_USER_ID_B``) on a separate app over the SAME container via the
shared ``client_for_user`` factory.
"""

from __future__ import annotations

import httpx
from fastapi import status

from margen_api.bootstrap import ApplicationContainer
from tests.conftest import STUB_AUTH_USER_B

BUDGET_INCOME = "/api/v1/budget-income"
JUNE = "2026-06"


class TestBudgetIncomeRoundTrip:
    """PUT then GET round-trips the net-income base + floor."""

    async def test_get_unset_month_is_null(self, test_client: httpx.AsyncClient):
        """
        GIVEN no income set for the month
        WHEN the income readout is requested
        THEN amount/source are null and the floor is null
        """
        # WHEN
        response = await test_client.get(BUDGET_INCOME, params={"month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["month"] == JUNE
        assert data["amount"] is None
        assert data["source"] is None
        assert data["currency"] == "ARS"
        assert data["floor"] == {"amount": None, "source": None}

    async def test_put_then_get_round_trips_income_and_floor(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income base + floor PUT for the month
        WHEN the income readout is requested
        THEN it reads back the persisted amount, source and floor
        """
        # GIVEN
        put = await test_client.put(
            BUDGET_INCOME,
            json={"month": JUNE, "amount": "1200000", "floorAmount": "500000", "floorSource": "manual"},
        )
        assert put.status_code == status.HTTP_200_OK, put.text

        # WHEN
        data = (await test_client.get(BUDGET_INCOME, params={"month": JUNE})).json()["data"]

        # THEN
        assert data["amount"] == "1200000.00"
        assert data["source"] == "manual"
        assert data["floor"] == {"amount": "500000.00", "source": "manual"}

    async def test_repeated_put_replaces_not_duplicates(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income base set for the month
        WHEN the same month is PUT again with a new amount
        THEN the base is replaced (the readout shows the new amount)
        """
        # GIVEN
        await test_client.put(BUDGET_INCOME, json={"month": JUNE, "amount": "1000000"})

        # WHEN
        await test_client.put(BUDGET_INCOME, json={"month": JUNE, "amount": "1500000"})

        # THEN
        data = (await test_client.get(BUDGET_INCOME, params={"month": JUNE})).json()["data"]
        assert data["amount"] == "1500000.00"

    async def test_unknown_currency_is_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a PUT body with an out-of-set currency
        WHEN the income is upserted
        THEN boundary validation rejects it with 422
        """
        # WHEN
        response = await test_client.put(BUDGET_INCOME, json={"month": JUNE, "amount": "1", "currency": "EUR"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_malformed_body_month_is_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a PUT body with a malformed month
        WHEN the income is upserted
        THEN the entrypoint rejects it with 422
        """
        # WHEN
        response = await test_client.put(BUDGET_INCOME, json={"month": "2026-13", "amount": "1"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_defaults_to_current_server_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN no month query param
        WHEN the income readout is requested
        THEN it returns 200 for the current server month
        """
        # WHEN
        response = await test_client.get(BUDGET_INCOME)

        # THEN
        assert response.status_code == status.HTTP_200_OK


class TestSuggestedBase:
    """GET /budget-income/suggested applies the lower-of rule over the income ledger."""

    async def test_suggested_is_null_with_zero_inflow_months(self, test_client: httpx.AsyncClient):
        """
        GIVEN a fresh ledger (no inflow rows)
        WHEN the suggested base is requested
        THEN it is null — the relaxed rule still needs ≥ 1 inflow month (ADR-153)
        """
        # WHEN
        response = await test_client.get(f"{BUDGET_INCOME}/suggested", params={"month": JUNE})

        # THEN
        data = response.json()["data"]
        assert response.status_code == status.HTTP_200_OK
        assert data["suggestedBase"] is None
        assert data["monthsAvailable"] == 0
        assert data["isSparse"] is True
        assert data["currency"] == "ARS"

    async def test_suggested_is_lower_of_average_and_lowest_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN 12 months of income inflow with one lean month
        WHEN the suggested base is requested for the latest month
        THEN it is the lowest month (the conservative floor)
        """
        # GIVEN — income in each of the 12 months Jul-2025..Jun-2026; June is lean.
        months = [f"2025-{m:02d}" for m in range(7, 13)] + [f"2026-{m:02d}" for m in range(1, 7)]
        for month in months:
            amount = "40000" if month == "2026-06" else "100000"
            response = await test_client.post(
                "/api/v1/transactions",
                json={
                    "occurredOn": f"{month}-10",
                    "name": "Payout",
                    "kind": "income",
                    "amountNum": amount,
                    "category": "Income",
                },
            )
            assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        data = (await test_client.get(f"{BUDGET_INCOME}/suggested", params={"month": JUNE})).json()["data"]

        # THEN — lower of (avg ~95000) and the lowest month (40000) = 40000.
        assert data["suggestedBase"] == "40000.00"

    async def test_defaults_to_current_server_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN no month query param
        WHEN the suggested base is requested
        THEN it returns 200 for the current server month
        """
        # WHEN
        response = await test_client.get(f"{BUDGET_INCOME}/suggested")

        # THEN
        assert response.status_code == status.HTTP_200_OK


class TestOwnership:
    """Income is owner-scoped: one user never sees another's base (ADR-130)."""

    async def test_user_b_does_not_see_user_a_income(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user: object,
    ):
        """
        GIVEN user A sets an income base for the month
        WHEN user B requests the same month's income
        THEN B's amount is null — A's base is invisible to B (ADR-130)
        """
        # GIVEN — user A sets income.
        await test_client.put(BUDGET_INCOME, json={"month": JUNE, "amount": "1000000"})

        # WHEN — user B reads over the SAME container.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            response = await client_b.get(BUDGET_INCOME, params={"month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["amount"] is None


class TestSuggestedBaseRelaxedAndUsd:
    """The suggestion estimates from available months and supports USD (ADR-152, ADR-153)."""

    async def _seed_income(self, client: httpx.AsyncClient, *, month: str, amount: str) -> None:
        """POST an ARS income inflow for a month, asserting 201."""
        response = await client.post(
            "/api/v1/transactions",
            json={"occurredOn": f"{month}-10", "name": "Payout", "kind": "income", "amountNum": amount},
        )
        assert response.status_code == status.HTTP_201_CREATED, response.text

    async def _seed_usd_income(self, client: httpx.AsyncClient, *, month: str, amount: str, rate: str | None) -> None:
        """POST a USD income inflow and optionally set its FX snapshot."""
        created = await client.post(
            "/api/v1/transactions",
            json={
                "occurredOn": f"{month}-10",
                "name": "Deel payout",
                "kind": "income",
                "amountNum": amount,
                "currency": "USD",
            },
        )
        assert created.status_code == status.HTTP_201_CREATED, created.text
        if rate is not None:
            row = created.json()["data"]
            snap = await client.put(
                f"/api/v1/transactions/{row['id']}/fx",
                json={"fxRate": rate, "fxSource": "bolsa"},
            )
            assert snap.status_code == status.HTTP_200_OK, snap.text

    async def test_single_month_is_sparse_estimate(self, test_client: httpx.AsyncClient):
        """
        GIVEN exactly one inflow month
        WHEN the suggested base is requested
        THEN it returns that month as a sparse estimate (monthsAvailable=1, isSparse) (ADR-153)
        """
        # GIVEN
        await self._seed_income(test_client, month=JUNE, amount="100000")

        # WHEN
        data = (await test_client.get(f"{BUDGET_INCOME}/suggested", params={"month": JUNE})).json()["data"]

        # THEN
        assert data["suggestedBase"] == "100000.00"
        assert data["monthsAvailable"] == 1
        assert data["isSparse"] is True
        assert data["currency"] == "ARS"

    async def test_three_months_lower_of_average_and_lowest(self, test_client: httpx.AsyncClient):
        """
        GIVEN three inflow months with one lean month
        WHEN the suggested base is requested
        THEN it is the lower-of(average, lowest) over the three available months (ADR-153)
        """
        # GIVEN — Apr/May 100000, Jun 40000.
        await self._seed_income(test_client, month="2026-04", amount="100000")
        await self._seed_income(test_client, month="2026-05", amount="100000")
        await self._seed_income(test_client, month=JUNE, amount="40000")

        # WHEN
        data = (await test_client.get(f"{BUDGET_INCOME}/suggested", params={"month": JUNE})).json()["data"]

        # THEN — average 80000 vs lowest 40000 -> 40000; 3 months, still sparse.
        assert data["suggestedBase"] == "40000.00"
        assert data["monthsAvailable"] == 3
        assert data["isSparse"] is True

    async def test_usd_sums_snapshot_inflow(self, test_client: httpx.AsyncClient):
        """
        GIVEN a USD inflow month with a snapshot and one without
        WHEN the suggested base is requested with currency=USD
        THEN it sums only the snapshotted usd_amount and ignores the unsnapshotted row (ADR-152)
        """
        # GIVEN — June: 100000 ARS @ 1000 -> usd 100.00 snapshot; May: USD with no snapshot.
        await self._seed_usd_income(test_client, month=JUNE, amount="100000", rate="1000")
        await self._seed_usd_income(test_client, month="2026-05", amount="50000", rate=None)

        # WHEN
        data = (await test_client.get(f"{BUDGET_INCOME}/suggested", params={"month": JUNE, "currency": "USD"})).json()[
            "data"
        ]

        # THEN — only June's snapshot contributes: one USD month of 100.00.
        assert data["suggestedBase"] == "100.00"
        assert data["monthsAvailable"] == 1
        assert data["currency"] == "USD"
