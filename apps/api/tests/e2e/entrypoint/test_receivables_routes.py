"""Route tests for the receivables entrypoint (ADR-204, ADR-206, ADR-207, ADR-130).

These drive the **REAL** application container on **in-memory async SQLite** (ADR-019/032)
through the HTTP edge, so people/items/payments/allocations are genuinely persisted and the
owner-scoped SQL, per-item remainder roll-ups, the ADR-206 overpayment contract and the
ADR-207 income-match suggestions are exercised end to end. User A is the default stub
(``STUB_USER_ID``); the cross-tenant checks use the second stub (``STUB_AUTH_USER_B``) on a
separate app over the SAME container via the shared ``client_for_user`` factory.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import status

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.bootstrap import ApplicationContainer
from margen_api.domain.models.value_objects import Currency, Kind
from tests.conftest import STUB_AUTH_USER_B, STUB_USER_ID

RECEIVABLES = "/api/v1/receivables"
PEOPLE = f"{RECEIVABLES}/people"

A_DATE = "2026-08-01"
_MISSING_ID = "00000000-0000-4000-8000-0000000000aa"


async def _create_person(client: httpx.AsyncClient, name: str = "Ana") -> dict:
    """POST a person and return the created detail resource, asserting 201."""
    response = await client.post(PEOPLE, json={"name": name})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


async def _add_item(client: httpx.AsyncClient, person_id: str, **body: object) -> dict:
    """POST an item to a person and return the refreshed person detail, asserting 201."""
    defaults: dict[str, object] = {"occurredOn": A_DATE, "amount": "1000", "detail": "lunch"}
    defaults.update(body)
    response = await client.post(f"{PEOPLE}/{person_id}/items", json=defaults)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]


async def _seed_transaction(
    container: ApplicationContainer,
    user_id: str,
    name: str,
    occurred_on: date,
    kind: Kind = Kind.INCOME,
) -> UUID:
    """Insert a transaction row directly (income by default), returning its id (ADR-207)."""
    session = container.session_factory()
    try:
        record = TransactionRecord()
        record.id = uuid4()
        record.user_id = UUID(user_id)
        record.occurred_on = occurred_on
        record.name = name
        record.kind = kind.value
        record.amount = Decimal("1000.00")
        record.currency = Currency.ARS.value
        record.created_at = datetime(2026, 1, 1, tzinfo=UTC)
        record.updated_at = datetime(2026, 1, 1, tzinfo=UTC)
        session.add(record)
        await session.commit()
        return record.id
    finally:
        await session.close()


async def _seed_income(container: ApplicationContainer, user_id: str, name: str, occurred_on: date) -> UUID:
    """Insert a ``kind='income'`` transaction row directly, returning its id (ADR-207)."""
    return await _seed_transaction(container, user_id, name, occurred_on, Kind.INCOME)


class TestPeopleCrud:
    """Create / list / get / rename / delete over the person aggregate (ADR-204, ADR-130)."""

    async def test_create_returns_201_with_empty_detail(self, test_client: httpx.AsyncClient):
        """
        GIVEN a valid create body
        WHEN the person is created
        THEN it returns 201 with the camelCase detail contract and no items yet
        """
        # WHEN
        created = await _create_person(test_client, name="Juan")

        # THEN
        assert created["name"] == "Juan"
        assert created["items"] == []
        assert "createdAt" in created and "outstanding" in created

    async def test_list_returns_owned_people_newest_first(self, test_client: httpx.AsyncClient):
        """
        GIVEN two created people
        WHEN the list endpoint is called
        THEN both are returned newest-first with an outstanding total (ADR-130)
        """
        # GIVEN
        await _create_person(test_client, name="First")
        await _create_person(test_client, name="Second")

        # WHEN
        response = await test_client.get(PEOPLE)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        names = [person["name"] for person in response.json()["data"]]
        assert names == ["Second", "First"]

    async def test_get_returns_person_with_item_rollups(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with two items
        WHEN the person is fetched
        THEN the detail carries each item's roll-up and the summed outstanding (ADR-206)
        """
        # GIVEN
        person = await _create_person(test_client)
        await _add_item(test_client, person["id"], amount="1000", occurredOn="2026-08-01")
        await _add_item(test_client, person["id"], amount="500", occurredOn="2026-09-01")

        # WHEN
        detail = (await test_client.get(f"{PEOPLE}/{person['id']}")).json()["data"]

        # THEN — newest-first by occurredOn; each item unallocated (remaining == amount); sum.
        assert [item["amount"] for item in detail["items"]] == ["500.00", "1000.00"]
        assert [item["remaining"] for item in detail["items"]] == ["500.00", "1000.00"]
        assert detail["outstanding"] == "1500.00"

    async def test_rename_updates_name(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing person
        WHEN it is renamed
        THEN the detail reflects the new name
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana")

        # WHEN
        response = await test_client.patch(f"{PEOPLE}/{person['id']}", json={"name": "Ana Perez"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"]["name"] == "Ana Perez"

    async def test_delete_removes_person(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing person
        WHEN it is deleted
        THEN it returns 204 and disappears from the list (cascade, ADR-208)
        """
        # GIVEN
        person = await _create_person(test_client)

        # WHEN
        response = await test_client.delete(f"{PEOPLE}/{person['id']}")

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert (await test_client.get(PEOPLE)).json()["data"] == []

    async def test_get_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN it is fetched
        THEN it returns 404 (ADR-111)
        """
        assert (await test_client.get(f"{PEOPLE}/{_MISSING_ID}")).status_code == status.HTTP_404_NOT_FOUND

    async def test_rename_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN it is renamed
        THEN it returns 404 (ADR-111)
        """
        response = await test_client.patch(f"{PEOPLE}/{_MISSING_ID}", json={"name": "Ghost"})
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_delete_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN it is deleted
        THEN it returns 404 (ADR-111)
        """
        assert (await test_client.delete(f"{PEOPLE}/{_MISSING_ID}")).status_code == status.HTTP_404_NOT_FOUND

    async def test_empty_name_is_rejected_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with an empty name
        WHEN the person is created
        THEN Pydantic rejects it with 422 (ADR-024/031)
        """
        assert (await test_client.post(PEOPLE, json={"name": ""})).status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestItemsCrud:
    """Add / edit / delete over a person's itemized debts (ADR-204, ADR-130)."""

    async def test_add_item_returns_refreshed_detail(self, test_client: httpx.AsyncClient):
        """
        GIVEN an existing person
        WHEN an item is added
        THEN the response is the person detail carrying the new item and outstanding
        """
        # GIVEN
        person = await _create_person(test_client)

        # WHEN
        detail = await _add_item(test_client, person["id"], amount="1000", detail="dinner")

        # THEN
        assert detail["items"][0]["amount"] == "1000.00"
        assert detail["items"][0]["detail"] == "dinner"
        assert detail["outstanding"] == "1000.00"

    async def test_edit_item_updates_present_fields(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with an item
        WHEN the item is patched with a new amount and detail
        THEN the refreshed detail reflects the change (ADR-028)
        """
        # GIVEN
        person = await _create_person(test_client)
        item_id = (await _add_item(test_client, person["id"], amount="1000"))["items"][0]["id"]

        # WHEN
        response = await test_client.patch(
            f"{PEOPLE}/{person['id']}/items/{item_id}",
            json={"amount": "800", "detail": "updated"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK
        item = response.json()["data"]["items"][0]
        assert item["amount"] == "800.00"
        assert item["detail"] == "updated"

    async def test_delete_item_removes_it(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with an item
        WHEN the item is deleted
        THEN it returns 204 and the person's outstanding drops to zero
        """
        # GIVEN
        person = await _create_person(test_client)
        item_id = (await _add_item(test_client, person["id"], amount="1000"))["items"][0]["id"]

        # WHEN
        response = await test_client.delete(f"{PEOPLE}/{person['id']}/items/{item_id}")

        # THEN
        assert response.status_code == status.HTTP_204_NO_CONTENT
        detail = (await test_client.get(f"{PEOPLE}/{person['id']}")).json()["data"]
        assert detail["items"] == []

    async def test_add_item_to_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN an item is added to it
        THEN it returns 404 (ADR-111)
        """
        response = await test_client.post(f"{PEOPLE}/{_MISSING_ID}/items", json={"occurredOn": A_DATE, "amount": "1"})
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_edit_missing_item_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person but no item with the requested id
        WHEN the item is patched
        THEN it returns 404 (ADR-111)
        """
        person = await _create_person(test_client)
        response = await test_client.patch(f"{PEOPLE}/{person['id']}/items/{_MISSING_ID}", json={"amount": "1"})
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_delete_missing_item_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person but no item with the requested id
        WHEN the item is deleted
        THEN it returns 404 (ADR-111)
        """
        person = await _create_person(test_client)
        response = await test_client.delete(f"{PEOPLE}/{person['id']}/items/{_MISSING_ID}")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_non_positive_amount_is_rejected_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a create body with a non-positive amount
        WHEN the item is added
        THEN Pydantic rejects it with 422 (ADR-025/031)
        """
        person = await _create_person(test_client)
        response = await test_client.post(f"{PEOPLE}/{person['id']}/items", json={"occurredOn": A_DATE, "amount": "0"})
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestPayments:
    """Record a manual payback allocated across items, incl. the ADR-206 settlement rules."""

    async def test_payment_reduces_item_remainders(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with a 1000 item
        WHEN a 600 payment allocated to the item is recorded
        THEN it returns 201 and the item's remaining and outstanding drop to 400 (ADR-206)
        """
        # GIVEN
        person = await _create_person(test_client)
        item_id = (await _add_item(test_client, person["id"], amount="1000"))["items"][0]["id"]

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/payments",
            json={
                "occurredOn": A_DATE,
                "amount": "600",
                "allocations": [{"itemId": item_id, "amount": "600"}],
            },
        )

        # THEN
        assert response.status_code == status.HTTP_201_CREATED, response.text
        detail = response.json()["data"]
        assert detail["outstanding"] == "400.00"
        assert detail["items"][0]["remaining"] == "400.00"
        assert detail["items"][0]["allocated"] == "600.00"

    async def test_payment_to_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN a payment is recorded against it
        THEN it returns 404 (ADR-111)
        """
        response = await test_client.post(
            f"{PEOPLE}/{_MISSING_ID}/payments",
            json={"occurredOn": A_DATE, "amount": "100", "allocations": [{"itemId": _MISSING_ID, "amount": "100"}]},
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_allocation_to_foreign_item_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person whose payment allocates to an item that is not theirs
        WHEN the payment is recorded
        THEN it returns 404 for the unknown item (ADR-206, ADR-111)
        """
        # GIVEN
        person = await _create_person(test_client)
        await _add_item(test_client, person["id"], amount="1000")

        # WHEN — allocate to a random, non-existent item id.
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/payments",
            json={"occurredOn": A_DATE, "amount": "100", "allocations": [{"itemId": _MISSING_ID, "amount": "100"}]},
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND

    async def test_allocation_exceeding_payment_is_hard_422(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with a 1000 item
        WHEN a 500 payment allocates 800 to the item
        THEN it is a hard 422 — a payment may not allocate more than it received (never a warning)
        """
        # GIVEN
        person = await _create_person(test_client)
        item_id = (await _add_item(test_client, person["id"], amount="1000"))["items"][0]["id"]

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/payments",
            json={"occurredOn": A_DATE, "amount": "500", "allocations": [{"itemId": item_id, "amount": "800"}]},
        )

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_overpayment_warns_409_then_retry_with_allow_succeeds(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person owing 1000
        WHEN a payment allocating 1500 is recorded without allowOverpayment
        THEN it returns a 409 warning carrying {code, outstanding, requested}
        AND retrying with allowOverpayment=true records the credit (201, negative outstanding)
        """
        # GIVEN
        person = await _create_person(test_client)
        item_id = (await _add_item(test_client, person["id"], amount="1000"))["items"][0]["id"]
        payload = {
            "occurredOn": A_DATE,
            "amount": "2000",
            "allocations": [{"itemId": item_id, "amount": "1500"}],
        }

        # WHEN — no override: the overpayment warning fires.
        warn = await test_client.post(f"{PEOPLE}/{person['id']}/payments", json=payload)

        # THEN — a distinct, machine-readable 409 the client can confirm against.
        assert warn.status_code == status.HTTP_409_CONFLICT
        body = warn.json()["detail"]
        assert body["code"] == "receivable_overpayment"
        assert body["outstanding"] == "1000.00"
        assert body["requested"] == "1500"

        # WHEN — the user confirms and retries with the override.
        confirmed = await test_client.post(
            f"{PEOPLE}/{person['id']}/payments",
            json={**payload, "allowOverpayment": True},
        )

        # THEN — the credit is recorded and the outstanding goes negative on purpose.
        assert confirmed.status_code == status.HTTP_201_CREATED, confirmed.text
        assert confirmed.json()["data"]["outstanding"] == "-500.00"


class TestMatchSuggestions:
    """Ranked income-match suggestions and the confirm-match flow (ADR-207, ADR-206)."""

    async def test_suggests_name_matching_income(self, test_client: httpx.AsyncClient, container: ApplicationContainer):
        """
        GIVEN a person "Ana" with an item and a matching income transaction
        WHEN the match-suggestions endpoint is called
        THEN it returns the ranked candidate with its id/name/amount/occurredOn/score
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana")
        await _add_item(test_client, person["id"], amount="1000", occurredOn=A_DATE)
        income_id = await _seed_income(container, STUB_USER_ID, "Ana", date(2026, 8, 5))

        # WHEN
        response = await test_client.get(f"{PEOPLE}/{person['id']}/match-suggestions")

        # THEN
        assert response.status_code == status.HTTP_200_OK
        suggestions = response.json()["data"]
        assert [s["transactionId"] for s in suggestions] == [str(income_id)]
        assert suggestions[0]["name"] == "Ana"
        assert suggestions[0]["amount"] == "1000.00"
        assert suggestions[0]["occurredOn"] == "2026-08-05"
        assert suggestions[0]["score"] == pytest.approx(1.0)

    async def test_no_items_yields_no_suggestions(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with no items (no date window)
        WHEN the match-suggestions endpoint is called
        THEN it returns an empty list (ADR-207)
        """
        person = await _create_person(test_client, name="Bob")
        response = await test_client.get(f"{PEOPLE}/{person['id']}/match-suggestions")
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["data"] == []

    async def test_confirm_match_creates_the_claim(
        self, test_client: httpx.AsyncClient, container: ApplicationContainer
    ):
        """
        GIVEN a person "Ana" with a 1000 item and a matching income
        WHEN the income is confirmed against the item
        THEN a matched-income payment settles the item (201, outstanding drops)
        AND the claimed income no longer resurfaces as a suggestion (ADR-207)
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana")
        item_id = (await _add_item(test_client, person["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]
        income_id = await _seed_income(container, STUB_USER_ID, "Ana", date(2026, 8, 5))

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": str(income_id),
                "allocations": [{"itemId": item_id, "amount": "1000"}],
            },
        )

        # THEN — the item is settled through the confirmed income.
        assert response.status_code == status.HTTP_201_CREATED, response.text
        assert response.json()["data"]["outstanding"] == "0.00"

        # AND — the now-claimed income is not re-suggested.
        suggestions = (await test_client.get(f"{PEOPLE}/{person['id']}/match-suggestions")).json()["data"]
        assert suggestions == []

    async def test_confirm_match_with_unknown_income_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with an item but a matched income id that does not exist
        WHEN the confirm-match endpoint is called
        THEN it returns 404 and no payment is created (ADR-207, ADR-111)
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana")
        item_id = (await _add_item(test_client, person["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": _MISSING_ID,
                "allocations": [{"itemId": item_id, "amount": "1000"}],
            },
        )

        # THEN — not found, and the item is still fully outstanding.
        assert response.status_code == status.HTTP_404_NOT_FOUND, response.text
        detail = (await test_client.get(f"{PEOPLE}/{person['id']}")).json()["data"]
        assert detail["outstanding"] == "1000.00"

    async def test_confirm_match_with_foreign_income_returns_404(
        self, test_client: httpx.AsyncClient, container: ApplicationContainer
    ):
        """
        GIVEN an income transaction owned by user B
        WHEN user A confirms it against their own person
        THEN it returns 404 without leaking existence (ADR-207, ADR-130, ADR-111)
        """
        # GIVEN — user B owns the income; user A (default stub) owns the person + item.
        person = await _create_person(test_client, name="Ana")
        item_id = (await _add_item(test_client, person["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]
        foreign_income = await _seed_income(container, STUB_AUTH_USER_B.id, "Ana", date(2026, 8, 5))

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": str(foreign_income),
                "allocations": [{"itemId": item_id, "amount": "1000"}],
            },
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND, response.text

    async def test_confirm_match_with_non_income_kind_returns_404(
        self, test_client: httpx.AsyncClient, container: ApplicationContainer
    ):
        """
        GIVEN one of the caller's transactions that is an EXPENSE (not an income)
        WHEN it is confirmed as a matched income
        THEN it returns 404 — only ``kind='income'`` transactions are settleable (ADR-207)
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana")
        item_id = (await _add_item(test_client, person["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]
        expense_id = await _seed_transaction(container, STUB_USER_ID, "Ana", date(2026, 8, 5), Kind.EXPENSE)

        # WHEN
        response = await test_client.post(
            f"{PEOPLE}/{person['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": str(expense_id),
                "allocations": [{"itemId": item_id, "amount": "1000"}],
            },
        )

        # THEN
        assert response.status_code == status.HTTP_404_NOT_FOUND, response.text

    async def test_confirm_match_with_already_claimed_income_returns_409(
        self, test_client: httpx.AsyncClient, container: ApplicationContainer
    ):
        """
        GIVEN an income already confirmed against one person (claimed)
        WHEN a second person confirms the SAME income
        THEN it returns 409 with the machine-readable code and settles nothing (ADR-207)
        """
        # GIVEN — first confirm claims the income against Ana.
        first = await _create_person(test_client, name="Ana")
        first_item = (await _add_item(test_client, first["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]
        income_id = await _seed_income(container, STUB_USER_ID, "Ana", date(2026, 8, 5))
        claim = await test_client.post(
            f"{PEOPLE}/{first['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": str(income_id),
                "allocations": [{"itemId": first_item, "amount": "1000"}],
            },
        )
        assert claim.status_code == status.HTTP_201_CREATED, claim.text

        # WHEN — a second person tries to reuse the now-claimed income.
        second = await _create_person(test_client, name="Ana II")
        second_item = (await _add_item(test_client, second["id"], amount="1000", occurredOn=A_DATE))["items"][0]["id"]
        response = await test_client.post(
            f"{PEOPLE}/{second['id']}/confirm-match",
            json={
                "occurredOn": "2026-08-05",
                "amount": "1000",
                "matchedIncomeTransactionId": str(income_id),
                "allocations": [{"itemId": second_item, "amount": "1000"}],
            },
        )

        # THEN — conflict with the terminal claimed code; the second debt stays outstanding.
        assert response.status_code == status.HTTP_409_CONFLICT, response.text
        assert response.json()["detail"]["code"] == "income_already_claimed"
        detail = (await test_client.get(f"{PEOPLE}/{second['id']}")).json()["data"]
        assert detail["outstanding"] == "1000.00"


class TestPersonPdf:
    """Download a person's outstanding-balance PDF statement (ADR-209, ADR-111)."""

    async def test_returns_pdf_attachment(self, test_client: httpx.AsyncClient):
        """
        GIVEN a person with an outstanding item
        WHEN the person's PDF is requested with no lang (Spanish default)
        THEN it returns 200 with an application/pdf attachment carrying a %PDF payload
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana Perez")
        await _add_item(test_client, person["id"], amount="1234.56", detail="lunch")

        # WHEN
        response = await test_client.get(f"{PEOPLE}/{person['id']}/pdf")

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        assert response.headers["content-type"] == "application/pdf"
        disposition = response.headers["content-disposition"]
        assert disposition == 'attachment; filename="receivable-Ana_Perez.pdf"'
        assert response.content.startswith(b"%PDF")

    @pytest.mark.parametrize("lang", ["es", "en", "fr"])
    async def test_renders_for_each_lang_and_unknown_falls_back(self, lang: str, test_client: httpx.AsyncClient):
        """
        GIVEN a person with an outstanding item
        WHEN the PDF is requested with ?lang=es, ?lang=en, or an unknown tag
        THEN each returns 200 with a %PDF payload (unknown normalizes to the es default)
        """
        # GIVEN
        person = await _create_person(test_client, name="Ana Perez")
        await _add_item(test_client, person["id"], amount="1234.56", detail="lunch")

        # WHEN
        response = await test_client.get(f"{PEOPLE}/{person['id']}/pdf", params={"lang": lang})

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF")

    async def test_missing_person_returns_404(self, test_client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id
        WHEN their PDF is requested
        THEN it returns 404 (ADR-111)
        """
        assert (await test_client.get(f"{PEOPLE}/{_MISSING_ID}/pdf")).status_code == status.HTTP_404_NOT_FOUND

    async def test_foreign_person_returns_404(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created a person
        WHEN user B requests that person's PDF
        THEN it returns 404 without leaking existence (ADR-130, ADR-111)
        """
        # GIVEN — user A (default stub) owns the person.
        person = await _create_person(test_client)

        # WHEN / THEN — user B cannot reach A's PDF.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            foreign = await client_b.get(f"{PEOPLE}/{person['id']}/pdf")
            assert foreign.status_code == status.HTTP_404_NOT_FOUND


class TestCrossTenant:
    """A user never sees or mutates another user's receivables (ADR-130, ADR-111)."""

    async def test_user_b_cannot_see_or_reach_user_a_person(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A created a person
        WHEN user B lists, fetches, renames and requests suggestions for A's person id
        THEN B's list is empty, B's reads/writes are 404 and suggestions are empty (ADR-111)
        """
        # GIVEN — user A (the default stub) creates a person.
        person = await _create_person(test_client)

        # WHEN / THEN — user B is fully isolated from A's rows.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            assert (await client_b.get(PEOPLE)).json()["data"] == []
            assert (await client_b.get(f"{PEOPLE}/{person['id']}")).status_code == status.HTTP_404_NOT_FOUND

            rename_b = await client_b.patch(f"{PEOPLE}/{person['id']}", json={"name": "Hijack"})
            assert rename_b.status_code == status.HTTP_404_NOT_FOUND

            suggest_b = await client_b.get(f"{PEOPLE}/{person['id']}/match-suggestions")
            assert suggest_b.json()["data"] == []
