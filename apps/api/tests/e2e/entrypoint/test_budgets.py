"""Route tests for the budgets entrypoint (ADR-125, ADR-032).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so budgets are genuinely persisted and the budgets-vs-actuals surface
joins real per-category targets with the real category-spend aggregation — the
slice's core behavior (target + spent + remaining per category, the UNIQUE upsert,
owner scoping) is exercised end to end, not mocked. User A is the default stub
(``STUB_USER_ID``); the cross-tenant check uses the second stub (``STUB_USER_ID_B``)
on a separate app over the SAME container via the shared ``client_for_user`` factory.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import status

from margen_api.bootstrap import ApplicationContainer
from tests.conftest import STUB_AUTH_USER_B

BUDGETS = "/api/v1/budgets"
TRANSACTIONS = "/api/v1/transactions"
JUNE = "2026-06"
A_DATE = "2026-06-12"


async def _seed_expense(client: httpx.AsyncClient, *, category: str, amount: str) -> None:
    """POST an expense transaction in the given category, asserting 201."""
    response = await client.post(
        TRANSACTIONS,
        json={
            "occurredOn": A_DATE,
            "name": f"{category} spend",
            "kind": "expense",
            "amountNum": amount,
            "category": category,
        },
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text


async def _put_budget(client: httpx.AsyncClient, **body: object) -> dict:
    """PUT a budget target and return the refreshed month surface, asserting 200."""
    defaults: dict[str, object] = {"category": "Food", "month": JUNE, "amount": "50000"}
    defaults.update(body)
    response = await client.put(BUDGETS, json=defaults)
    assert response.status_code == status.HTTP_200_OK, response.text
    return response.json()["data"]


def _line(surface: dict, category: str) -> dict:
    """Return the budget line for a category from the surface."""
    return next(line for line in surface["categories"] if line["category"] == category)


class TestBudgetSurface:
    """GET returns target + spent + remaining per expense category for a month."""

    async def test_get_returns_every_expense_category_with_null_target_when_unset(self, test_client: httpx.AsyncClient):
        """
        GIVEN no budgets set
        WHEN the budgets surface is requested for a month
        THEN every expense category appears with a null target/remaining and 0 spent
        """
        # WHEN
        response = await test_client.get(BUDGETS, params={"month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["month"] == JUNE
        assert data["currency"] == "ARS"
        food = _line(data, "Food")
        assert food["target"] is None
        assert food["remaining"] is None
        assert food["spent"] == "0"
        # Income is an inflow, never a budget line (ADR-125).
        assert all(line["category"] != "Income" for line in data["categories"])

    async def test_get_pairs_target_with_seeded_spend_and_remaining(self, test_client: httpx.AsyncClient):
        """
        GIVEN a seeded Food expense and a Food target for the month
        WHEN the budgets surface is requested
        THEN the Food line carries target, the actual spend and remaining = target - spent
        """
        # GIVEN
        await _seed_expense(test_client, category="Food", amount="20000.00")
        await _put_budget(test_client, category="Food", month=JUNE, amount="50000")

        # WHEN
        response = await test_client.get(BUDGETS, params={"month": JUNE})

        # THEN
        food = _line(response.json()["data"], "Food")
        assert food["target"] == "50000.00"
        assert food["spent"] == "20000.00"
        assert food["remaining"] == "30000.00"

    async def test_defaults_to_current_server_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN no month query param
        WHEN the budgets surface is requested
        THEN it returns 200 for the current server month
        """
        # WHEN
        response = await test_client.get(BUDGETS)

        # THEN
        assert response.status_code == status.HTTP_200_OK

    @pytest.mark.parametrize("bad_month", ["2026-13", "2026-6", "june", "2026/06", "2026-00"])
    async def test_malformed_month_returns_422(self, test_client: httpx.AsyncClient, bad_month: str):
        """
        GIVEN a malformed month query param
        WHEN the budgets surface is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await test_client.get(BUDGETS, params={"month": bad_month})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestUpsert:
    """PUT sets and replaces a category's target (UNIQUE per category/month)."""

    async def test_repeated_put_replaces_target_not_duplicates(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Food target already set for the month
        WHEN the same category/month is PUT again with a new amount
        THEN the target is replaced (not duplicated) — one Food line, the new amount
        """
        # GIVEN
        await _put_budget(test_client, category="Food", month=JUNE, amount="50000")

        # WHEN
        surface = await _put_budget(test_client, category="Food", month=JUNE, amount="75000")

        # THEN — exactly one Food line, carrying the replaced amount.
        food_lines = [line for line in surface["categories"] if line["category"] == "Food"]
        assert len(food_lines) == 1
        assert food_lines[0]["target"] == "75000.00"

    async def test_target_is_scoped_to_the_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Food target for June
        WHEN July's surface is requested
        THEN July's Food target is null (targets do not leak across months)
        """
        # GIVEN
        await _put_budget(test_client, category="Food", month=JUNE, amount="50000")

        # WHEN
        response = await test_client.get(BUDGETS, params={"month": "2026-07"})

        # THEN
        assert _line(response.json()["data"], "Food")["target"] is None

    async def test_unknown_currency_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a PUT body with an out-of-set currency
        WHEN the budget is upserted
        THEN boundary validation (the Currency enum field) rejects it with 422
        """
        # WHEN
        response = await test_client.put(
            BUDGETS, json={"category": "Food", "month": JUNE, "amount": "1", "currency": "EUR"}
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_malformed_body_month_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a PUT body with a malformed month
        WHEN the budget is upserted
        THEN the entrypoint rejects it with 422
        """
        # WHEN
        response = await test_client.put(BUDGETS, json={"category": "Food", "month": "2026-13", "amount": "1"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestClear:
    """DELETE clears a target and is idempotent."""

    async def test_delete_clears_target(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Food target set for the month
        WHEN it is cleared via DELETE
        THEN the surface reads back a null Food target
        """
        # GIVEN
        await _put_budget(test_client, category="Food", month=JUNE, amount="50000")

        # WHEN
        response = await test_client.delete(BUDGETS, params={"category": "Food", "month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT
        surface = (await test_client.get(BUDGETS, params={"month": JUNE})).json()["data"]
        assert _line(surface, "Food")["target"] is None

    async def test_delete_absent_target_is_idempotent_204(self, test_client: httpx.AsyncClient):
        """
        GIVEN no Food target
        WHEN it is cleared via DELETE
        THEN the endpoint still answers 204 (idempotent clear, ADR-125)
        """
        # WHEN
        response = await test_client.delete(BUDGETS, params={"category": "Food", "month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT


class TestOwnership:
    """Budgets are owner-scoped: one user never sees another's targets (ADR-130)."""

    async def test_user_b_does_not_see_user_a_targets(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user: object,
    ):
        """
        GIVEN user A sets a Food target for the month
        WHEN user B requests the same month's budgets surface
        THEN B's Food target is null — A's target is invisible to B (ADR-130)
        """
        # GIVEN — user A (the default stub client) sets a target.
        await _put_budget(test_client, category="Food", month=JUNE, amount="50000")

        # WHEN — user B reads over the SAME container.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:  # type: ignore[operator]
            response = await client_b.get(BUDGETS, params={"month": JUNE})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert _line(response.json()["data"], "Food")["target"] is None


BUDGET_INCOME = "/api/v1/budget-income"


async def _put_income(client: httpx.AsyncClient, **body: object) -> dict:
    """PUT a net-income base and return the readout, asserting 200."""
    defaults: dict[str, object] = {"month": JUNE, "amount": "1000000"}
    defaults.update(body)
    response = await client.put(BUDGET_INCOME, json=defaults)
    assert response.status_code == status.HTTP_200_OK, response.text
    return response.json()["data"]


class TestExtendedSurface:
    """GET /budgets carries savings, floor, suggestedStrategy and pressure (ADR-138, ADR-143)."""

    async def test_surface_has_savings_floor_and_advisory_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN no budgets and no income set
        WHEN the surface is requested
        THEN it carries empty savings, a null floor, and null advisory fields
        """
        # WHEN
        data = (await test_client.get(BUDGETS, params={"month": JUNE})).json()["data"]

        # THEN
        assert data["savings"] == []
        assert data["floor"] == {"amount": None, "source": None}
        assert data["suggestedStrategy"] is None
        assert data["pressure"] is None

    async def test_income_and_floor_drive_advisory_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income base and a floor
        WHEN the surface is requested
        THEN the floor readout and the strategy/pressure advisory fields populate
        """
        # GIVEN — income 1,000,000, floor 300,000 (3.33x -> comfortable -> aggressive).
        await _put_income(test_client, month=JUNE, amount="1000000", floorAmount="300000", floorSource="manual")

        # WHEN
        data = (await test_client.get(BUDGETS, params={"month": JUNE})).json()["data"]

        # THEN
        assert data["floor"] == {"amount": "300000.00", "source": "manual"}
        assert data["pressure"] == "comfortable"
        assert data["suggestedStrategy"] == "aggressive"


class TestApplyProfile:
    """POST /budgets/apply-profile writes saving rows and reports the floor guard."""

    async def test_apply_profile_populates_savings_without_leaking_into_categories(
        self, test_client: httpx.AsyncClient
    ):
        """
        GIVEN an income base
        WHEN the Balanced profile is applied
        THEN savings[] is populated, floorBreached is false, and no saving bucket
             leaks into categories[]
        """
        # GIVEN
        await _put_income(test_client, month=JUNE, amount="1000000")

        # WHEN
        response = await test_client.post(f"{BUDGETS}/apply-profile", json={"month": JUNE, "profile": "balanced"})

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        data = response.json()["data"]
        buckets = {line["bucket"] for line in data["savings"]}
        assert "EmergencyFund" in buckets
        assert data["floorBreached"] is False
        emergency = next(line for line in data["savings"] if line["bucket"] == "EmergencyFund")
        assert emergency["amount"] == "70000.00"  # Balanced 7%
        assert emergency["percent"] == "7.0"
        # Guard: a saving bucket NEVER appears as a spend category line (ADR-138).
        category_names = {line["category"] for line in data["categories"]}
        assert category_names.isdisjoint(buckets)

    async def test_apply_profile_reflected_on_subsequent_get(self, test_client: httpx.AsyncClient):
        """
        GIVEN a profile applied for the month
        WHEN GET /budgets is requested
        THEN the saving rows persist and surface under savings[]
        """
        # GIVEN
        await _put_income(test_client, month=JUNE, amount="1000000")
        await test_client.post(f"{BUDGETS}/apply-profile", json={"month": JUNE, "profile": "conservative"})

        # WHEN
        data = (await test_client.get(BUDGETS, params={"month": JUNE})).json()["data"]

        # THEN
        assert {line["bucket"] for line in data["savings"]}  # non-empty
        assert all(line["category"] not in {"EmergencyFund", "FxHedge"} for line in data["categories"])

    async def test_apply_profile_without_income_is_409(self, test_client: httpx.AsyncClient):
        """
        GIVEN no income base for the month
        WHEN a profile is applied
        THEN the endpoint answers 409 (set income first)
        """
        # WHEN
        response = await test_client.post(f"{BUDGETS}/apply-profile", json={"month": JUNE, "profile": "balanced"})

        # THEN
        assert response.status_code == status.HTTP_409_CONFLICT

    async def test_apply_unknown_profile_is_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income base but an unknown profile
        WHEN a profile is applied
        THEN the endpoint answers 422
        """
        # GIVEN
        await _put_income(test_client, month=JUNE, amount="1000000")

        # WHEN
        response = await test_client.post(f"{BUDGETS}/apply-profile", json={"month": JUNE, "profile": "reckless"})

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_apply_profile_flags_floor_breach_with_gap(self, test_client: httpx.AsyncClient):
        """
        GIVEN an income base whose floor leaves little room
        WHEN an Aggressive profile is applied
        THEN floorBreached is true and a gap is reported (rows still written)
        """
        # GIVEN — income 1000, floor 900, Aggressive saves 40% -> residual 600 < 900.
        await _put_income(test_client, month=JUNE, amount="1000", floorAmount="900")

        # WHEN
        data = (
            await test_client.post(f"{BUDGETS}/apply-profile", json={"month": JUNE, "profile": "aggressive"})
        ).json()["data"]

        # THEN
        assert data["floorBreached"] is True
        assert data["gap"] == "300.00"
        assert data["savings"]  # rows still written


class TestReprice:
    """POST /budgets/reprice produces repriced spend rows in the target month (ADR-137)."""

    async def test_reprice_produces_new_month_spend_rows(self, test_client: httpx.AsyncClient):
        """
        GIVEN a June Food target
        WHEN June is repriced into July at 2% inflation
        THEN July's Food target is the repriced cap
        """
        # GIVEN
        await _put_budget(test_client, category="Food", month=JUNE, amount="100000")

        # WHEN
        response = await test_client.post(
            f"{BUDGETS}/reprice",
            json={"fromMonth": JUNE, "toMonth": "2026-07", "monthlyInflation": "2"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        data = response.json()["data"]
        assert data["month"] == "2026-07"
        food = _line(data, "Food")
        assert food["target"] == "102000.00"

    async def test_reprice_applies_step_up(self, test_client: httpx.AsyncClient):
        """
        GIVEN a June Housing target and a Housing step-up
        WHEN June is repriced into July
        THEN July's Housing target adds the step-up after inflation
        """
        # GIVEN
        await _put_budget(test_client, category="Housing", month=JUNE, amount="100000")

        # WHEN — 100000 * 1.02 = 102000 + 20000.
        data = (
            await test_client.post(
                f"{BUDGETS}/reprice",
                json={
                    "fromMonth": JUNE,
                    "toMonth": "2026-07",
                    "monthlyInflation": "2",
                    "stepUps": {"Housing": "20000"},
                },
            )
        ).json()["data"]

        # THEN
        assert _line(data, "Housing")["target"] == "122000.00"
