"""Route tests for reimbursement netting end to end (ADR-158..162, ADR-032).

These drive the **REAL** application container on **in-memory async SQLite**
(ADR-019/032) so reimbursements are genuinely persisted, the offset self-FK links
paybacks to their source expense, and the net-of-reimbursements category spend is
computed by the real SQL aggregation — the slice's core behavior is exercised end to
end, not mocked. User A is the default stub (``STUB_USER_ID``); the cross-owner
rejection uses the second stub (``STUB_AUTH_USER_B``) on a separate app over the SAME
container via the shared ``client_for_user`` factory.

Covers the ADR-162 correctness matrix from the API surface: budget net + reimbursed
chip, the timing-skew attribution (payback in a different month than the expense), N
paybacks to one expense, the USD-via-expense-rate reduction, the over-refund floor,
and the same-owner offset-link rejection.
"""

from __future__ import annotations

import httpx
from fastapi import status

from margen_api.bootstrap import ApplicationContainer
from tests.conftest import STUB_AUTH_USER_B

BUDGETS = "/api/v1/budgets"
TRANSACTIONS = "/api/v1/transactions"
JUNE = "2026-06"
JULY = "2026-07"
JUNE_DATE = "2026-06-12"
JULY_DATE = "2026-07-05"


async def _create_expense(
    client: httpx.AsyncClient,
    *,
    category: str = "Social",
    amount: str = "10000",
    occurred_on: str = JUNE_DATE,
    fx_rate: str | None = None,
    fx_source: str | None = None,
) -> str:
    """POST an expense and return its id, asserting 201. Optionally captures an FX snapshot."""
    body: dict[str, object] = {
        "occurredOn": occurred_on,
        "name": f"{category} spend",
        "kind": "expense",
        "amountNum": amount,
        "category": category,
    }
    if fx_rate is not None:
        body["rate"] = fx_rate
        body["fxSource"] = fx_source or "bolsa"
    response = await client.post(TRANSACTIONS, json=body)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]["id"]


async def _create_reimbursement(
    client: httpx.AsyncClient,
    *,
    offsets: str,
    amount: str,
    occurred_on: str = JUNE_DATE,
) -> httpx.Response:
    """POST a reimbursement linked to an expense and return the raw response."""
    return await client.post(
        TRANSACTIONS,
        json={
            "occurredOn": occurred_on,
            "name": "Friend pays back",
            "kind": "reimbursement",
            "amountNum": amount,
            "offsetsTransactionId": offsets,
        },
    )


def _line(surface: dict, category: str) -> dict:
    """Return the budget line for a category from the surface."""
    return next(line for line in surface["categories"] if line["category"] == category)


async def _budget(client: httpx.AsyncClient, month: str = JUNE, currency: str = "ARS") -> dict:
    """GET the month's budget surface and return the data envelope, asserting 200."""
    response = await client.get(BUDGETS, params={"month": month, "currency": currency})
    assert response.status_code == status.HTTP_200_OK, response.text
    return response.json()["data"]


class TestNetSpendAndReimbursedChip:
    """Budget spend is net of linked reimbursements, with the gross reduction surfaced."""

    async def test_partial_payback_nets_spend_and_reports_reimbursed(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Social expense of 10000 and a linked partial payback of 3000
        WHEN the June budget is read
        THEN Social 'spent' is the net 7000 and 'reimbursed' reports the gross 3000 (ADR-160)
        """
        # GIVEN
        expense_id = await _create_expense(test_client, category="Social", amount="10000")
        response = await _create_reimbursement(test_client, offsets=expense_id, amount="3000")
        assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        social = _line(await _budget(test_client), "Social")

        # THEN
        assert social["spent"] == "7000.00"
        assert social["reimbursed"] == "3000.00"

    async def test_no_reimbursement_reports_zero_reimbursed(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Social expense with no payback
        WHEN the June budget is read
        THEN 'spent' is the gross and 'reimbursed' is zero
        """
        # GIVEN
        await _create_expense(test_client, category="Social", amount="8000")

        # WHEN
        social = _line(await _budget(test_client), "Social")

        # THEN
        assert social["spent"] == "8000.00"
        assert social["reimbursed"] == "0"

    async def test_n_paybacks_to_one_expense_sum(self, test_client: httpx.AsyncClient):
        """
        GIVEN one expense of 12000 and three separate paybacks (3000 + 3000 + 2000)
        WHEN the June budget is read
        THEN the three paybacks all subtract from the same expense's category-month (ADR-159 N->1)
        """
        # GIVEN
        expense_id = await _create_expense(test_client, category="Social", amount="12000")
        for amount in ("3000", "3000", "2000"):
            response = await _create_reimbursement(test_client, offsets=expense_id, amount=amount)
            assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        social = _line(await _budget(test_client), "Social")

        # THEN — net = 12000 - 8000 = 4000; reimbursed = 8000.
        assert social["spent"] == "4000.00"
        assert social["reimbursed"] == "8000.00"


class TestTimingSkew:
    """Netting attributes to the LINKED EXPENSE's month, not the payback's (ADR-159)."""

    async def test_payback_in_later_month_nets_the_expense_month(self, test_client: httpx.AsyncClient):
        """
        GIVEN a June expense whose payback arrives in July
        WHEN both months' budgets are read
        THEN June is netted (the expense month) and July is untouched (ADR-159 timing skew)
        """
        # GIVEN — expense in June, payback recorded in July.
        expense_id = await _create_expense(test_client, category="Social", amount="10000", occurred_on=JUNE_DATE)
        response = await _create_reimbursement(test_client, offsets=expense_id, amount="4000", occurred_on=JULY_DATE)
        assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        june_social = _line(await _budget(test_client, month=JUNE), "Social")
        july_social = _line(await _budget(test_client, month=JULY), "Social")

        # THEN — June nets by the expense month; July shows no spend and no reimbursed.
        assert june_social["spent"] == "6000.00"
        assert june_social["reimbursed"] == "4000.00"
        assert july_social["spent"] == "0"
        assert july_social["reimbursed"] == "0"


class TestOverRefundFloor:
    """Over-refund floors the category at zero (ADR-162)."""

    async def test_over_refund_floors_at_zero(self, test_client: httpx.AsyncClient):
        """
        GIVEN a 10000 expense with paybacks totalling 12000 (friends over-transfer)
        WHEN the June budget is read
        THEN Social 'spent' floors at zero, never negative (ADR-162)
        """
        # GIVEN
        expense_id = await _create_expense(test_client, category="Social", amount="10000")
        for amount in ("7000", "5000"):
            response = await _create_reimbursement(test_client, offsets=expense_id, amount=amount)
            assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        social = _line(await _budget(test_client), "Social")

        # THEN — 10000 - 12000 floors at 0; the gross reduction is still reported.
        assert social["spent"] == "0"
        assert social["reimbursed"] == "12000.00"


class TestUsdViaExpenseRate:
    """USD reduction rides the linked expense's captured rate (ADR-161)."""

    async def test_usd_net_uses_expense_rate(self, test_client: httpx.AsyncClient):
        """
        GIVEN a Social expense of ARS 10000 captured at rate 1000 (USD 10.00) and a
              linked payback of ARS 3000
        WHEN the USD June budget is read
        THEN the payback's USD reduction is 3000/1000 = 3.00, so net USD is 7.00 (ADR-161)
        """
        # GIVEN — expense carries an FX snapshot (rate 1000 => usd 10.00).
        expense_id = await _create_expense(
            test_client, category="Social", amount="10000", fx_rate="1000", fx_source="bolsa"
        )
        response = await _create_reimbursement(test_client, offsets=expense_id, amount="3000")
        assert response.status_code == status.HTTP_201_CREATED, response.text

        # WHEN
        social = _line(await _budget(test_client, currency="USD"), "Social")

        # THEN — net USD = 10.00 - (3000/1000) = 7.00; reimbursed USD = 3.00.
        assert social["spent"] == "7.00"
        assert social["reimbursed"] == "3.00"


class TestOffsetLinkValidation:
    """The offset link is validated at the app layer (ADR-159, ADR-130)."""

    async def test_missing_target_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a reimbursement linking a non-existent expense id
        WHEN it is created
        THEN the API answers 404 (the offset target is not found, ADR-111)
        """
        # WHEN
        response = await _create_reimbursement(
            test_client, offsets="00000000-0000-4000-8000-000000000999", amount="3000"
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND, response.text

    async def test_non_expense_target_returns_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a reimbursement linking an income transaction as its offset target
        WHEN it is created
        THEN the API answers 422 (a payback may only offset an expense, ADR-159)
        """
        # GIVEN — an income row to (incorrectly) link.
        income = await test_client.post(
            TRANSACTIONS,
            json={"occurredOn": JUNE_DATE, "name": "Salary", "kind": "income", "amountNum": "500000"},
        )
        assert income.status_code == status.HTTP_201_CREATED, income.text
        income_id = income.json()["data"]["id"]

        # WHEN
        response = await _create_reimbursement(test_client, offsets=income_id, amount="3000")

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT, response.text

    async def test_cross_owner_target_returns_404(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN an expense owned by user B
        WHEN user A creates a reimbursement offsetting B's expense
        THEN the API answers 404 — existence is never leaked across tenants (ADR-130, ADR-111)
        """
        # GIVEN — B seeds an expense on the shared container.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            b_expense_id = await _create_expense(client_b, category="Social", amount="10000")

        # WHEN — A links B's expense.
        response = await _create_reimbursement(test_client, offsets=b_expense_id, amount="3000")

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND, response.text


class TestReimbursementResponseContract:
    """The transaction response exposes the offset link (ADR-158/159)."""

    async def test_reimbursement_response_carries_offsets_transaction_id(self, test_client: httpx.AsyncClient):
        """
        GIVEN a reimbursement linked to an expense
        WHEN the created transaction is returned
        THEN the response exposes 'offsetsTransactionId' and no FX snapshot (ADR-161)
        """
        # GIVEN
        expense_id = await _create_expense(test_client, category="Social", amount="10000")

        # WHEN
        response = await _create_reimbursement(test_client, offsets=expense_id, amount="3000")
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()["data"]

        # THEN
        assert data["offsetsTransactionId"] == expense_id
        assert data["kind"] == "reimbursement"
        assert data["type"] == "income"
        assert data["rate"] is None
        assert data["usd"] is None
        assert data["fxSource"] is None
