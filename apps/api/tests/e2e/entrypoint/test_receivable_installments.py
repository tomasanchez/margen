"""Route tests for receivable installments (cuotas) and the expense link (ADR-214..223).

These drive the REAL application container through the HTTP edge on in-memory async SQLite
(ADR-019/032). Unlike the default e2e container, this module's container turns SQLite's
``foreign_keys`` pragma ON, so the cuota writes are proven against real FK and unique
constraints: an item is inserted before its cuotas, and a re-schedule removes the old cuotas
before re-using their indexes (the orderings PostgreSQL enforces, ADR-223).

"Today" is pinned through the ``get_today`` dependency override (ADR-223) so the due/upcoming
split is deterministic: the 3 x 1000 plan used throughout falls due Jul 10, Aug 10 and Sep 10
2026, and today is Aug 10 unless a test moves it — two cuotas due, one upcoming.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI, status
from sqlalchemy import event

from margen_api.adapters.models.receivable import ReceivableItemRecord
from margen_api.asgi import get_application
from margen_api.bootstrap import ApplicationContainer, bootstrap
from margen_api.entrypoint.dependencies import get_today
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B

PEOPLE = "/api/v1/receivables/people"
CANDIDATES = "/api/v1/receivables/expense-candidates"
TRANSACTIONS = "/api/v1/transactions"
INSTITUTIONS = "/api/v1/institutions"
ACCOUNTS = "/api/v1/accounts"
NET_WORTH = "/api/v1/accounts/net-worth"
BUDGETS = "/api/v1/budgets"

TODAY = date(2026, 8, 10)
PLAN = {"count": 3, "firstDueOn": "2026-07-10"}
_MISSING_ID = "00000000-0000-4000-8000-0000000000aa"


# The DBAPI hook receives SQLAlchemy's untyped driver adapter objects, hence Any.
def _enforce_foreign_keys(dbapi_connection: Any, _connection_record: Any) -> None:
    """Turn SQLite's per-connection foreign-key enforcement on (off by default)."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


@pytest.fixture(name="fk_container")
async def fixture_fk_container() -> AsyncIterator[ApplicationContainer]:
    """Build an in-memory container whose SQLite connection enforces foreign keys."""
    container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=True))
    event.listen(container.engine.sync_engine, "connect", _enforce_foreign_keys)
    await container.startup()
    yield container
    await container.shutdown()


@pytest.fixture(name="app")
def fixture_app(fk_container: ApplicationContainer) -> FastAPI:
    """Build the app over the FK-enforcing container with "today" pinned to Aug 10 2026."""
    app = get_application(fk_container)
    app.dependency_overrides[get_today] = lambda: TODAY
    return app


@pytest.fixture(name="client")
async def fixture_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an async client for the pinned-today app."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


async def _person(client: httpx.AsyncClient, name: str = "Juan") -> str:
    """Create a person and return its id."""
    response = await client.post(PEOPLE, json={"name": name})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]["id"]


async def _add_item(client: httpx.AsyncClient, person_id: str, **body: object) -> dict:
    """Add an item (3000 split into the 3-cuota plan by default) and return the new item."""
    payload: dict[str, object] = {"occurredOn": "2026-07-01", "amount": "3000", "installments": PLAN}
    payload.update(body)
    response = await client.post(f"{PEOPLE}/{person_id}/items", json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    created = response.json()["data"]
    return next(item for item in created["items"] if item["id"] == created["createdItemId"])


async def _detail(client: httpx.AsyncClient, person_id: str) -> dict:
    """GET a person's detail, asserting 200."""
    response = await client.get(f"{PEOPLE}/{person_id}")
    assert response.status_code == status.HTTP_200_OK, response.text
    return response.json()["data"]


async def _pay(client: httpx.AsyncClient, person_id: str, allocations: list[dict], **extra: object) -> httpx.Response:
    """POST a manual payment whose amount is the sum of its allocations."""
    total = sum(float(allocation["amount"]) for allocation in allocations)
    payload: dict[str, object] = {"occurredOn": "2026-08-10", "amount": f"{total:.2f}", "allocations": allocations}
    payload.update(extra)
    return await client.post(f"{PEOPLE}/{person_id}/payments", json=payload)


def _running_balances(html: str) -> list[str]:
    """Return the statement ledger's non-empty running Saldo cells in order (not the closing total)."""
    return [balance for balance in re.findall(r'<td class="c-bal">([^<]*)</td>', html) if balance]


async def _expense(client: httpx.AsyncClient, *, name: str = "Cena", amount: str = "9000", **body: object) -> str:
    """Create an expense through the transactions route and return its id."""
    payload: dict[str, object] = {"occurredOn": "2026-07-01", "name": name, "kind": "expense", "amountNum": amount}
    payload.update(body)
    response = await client.post(TRANSACTIONS, json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return response.json()["data"]["id"]


class TestInstallmentItems:
    """Creating and reading an installment item: due vs. upcoming as of today (ADR-214, ADR-215)."""

    async def test_create_reports_cuotas_due_and_upcoming_as_of_today(self, client: httpx.AsyncClient, app: FastAPI):
        """
        GIVEN today is Aug 10 2026
        WHEN 3000 is added split into 3 cuotas from Jul 10
        THEN the item lists cuotas 1..3 (due, due, upcoming), dueOutstanding 2000 and
             upcomingTotal 1000; the person's outstanding counts only the due 2000 — in the
             detail and in the people list — and moving today past Sep 10 makes all 3000 due
        """
        # GIVEN
        person_id = await _person(client)

        # WHEN
        item = await _add_item(client, person_id)

        # THEN
        assert item["amount"] == "3000.00"
        assert [cuota["index"] for cuota in item["installments"]] == [1, 2, 3]
        assert [cuota["dueOn"] for cuota in item["installments"]] == ["2026-07-10", "2026-08-10", "2026-09-10"]
        assert [cuota["amount"] for cuota in item["installments"]] == ["1000.00", "1000.00", "1000.00"]
        assert [cuota["status"] for cuota in item["installments"]] == ["due", "due", "upcoming"]
        assert item["installments"][0]["paid"] == "0"
        assert item["installments"][0]["remaining"] == "1000.00"
        assert item["installments"][0]["pardoned"] is False
        assert item["dueOutstanding"] == "2000.00"
        assert item["upcomingTotal"] == "1000.00"
        assert item["remaining"] == "3000.00"
        assert item["sourceTransaction"] is None
        assert item["linkedTotalExceedsExpense"] is False
        detail = await _detail(client, person_id)
        assert detail["outstanding"] == "2000.00"
        assert detail["upcomingTotal"] == "1000.00"
        listed = (await client.get(PEOPLE)).json()["data"][0]
        assert (listed["outstanding"], listed["upcomingTotal"]) == ("2000.00", "1000.00")

        # WHEN — "today" moves past the last due date.
        app.dependency_overrides[get_today] = lambda: date(2026, 9, 10)

        # THEN — every cuota is due now.
        later = await _detail(client, person_id)
        assert later["outstanding"] == "3000.00"
        assert later["upcomingTotal"] == "0"

    async def test_flat_items_keep_counting_in_full(self, client: httpx.AsyncClient):
        """
        GIVEN a person with a flat 500 item next to the 3-cuota plan
        WHEN the detail is read
        THEN the flat item has no cuotas and counts its whole 500 (ADR-206 unchanged)
        """
        # GIVEN
        person_id = await _person(client)
        await _add_item(client, person_id)
        flat = await _add_item(client, person_id, occurredOn="2026-07-20", amount="500", installments=None)

        # THEN
        assert flat["installments"] == []
        assert (flat["dueOutstanding"], flat["upcomingTotal"]) == ("500.00", "0")
        assert (await _detail(client, person_id))["outstanding"] == "2500.00"

    @pytest.mark.parametrize(
        ("body", "code"),
        [
            ({"amount": "0.01", "installments": {"count": 2, "firstDueOn": "2026-07-10"}}, 422),
            ({"installments": {"count": 1, "firstDueOn": "2026-07-10"}}, 422),
            ({"installments": {"count": 121, "firstDueOn": "2026-07-10"}}, 422),
        ],
    )
    async def test_impossible_plans_are_rejected(self, client: httpx.AsyncClient, body: dict, code: int):
        """
        GIVEN a plan that cannot exist (too small to split, a single cuota, or too many)
        WHEN the item is added
        THEN it is rejected with 422 and nothing is created
        """
        # GIVEN
        person_id = await _person(client)
        payload = {"occurredOn": "2026-07-01", "amount": "3000", **body}

        # WHEN
        response = await client.post(f"{PEOPLE}/{person_id}/items", json=payload)

        # THEN
        assert response.status_code == code, response.text
        assert (await _detail(client, person_id))["items"] == []

    async def test_pdf_renders_one_row_per_due_cuota_and_the_upcoming_total(
        self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """
        GIVEN today is Aug 10 2026 and a 4 x 1000 "TV" plan from Jun 10 with cuota 1 paid,
              cuota 2 pardoned, cuota 3 due and cuota 4 upcoming
        WHEN the statement is exported by default (Spanish) and with ?full=true in English
        THEN the default ledger lists only "TV · Cuota 3/4" and closes on the due-only hero
             1.000,00, with the upcoming 1.000,00 shown apart and the forgiven cuota covered; the
             full ledger tags every cuota by status and also closes on the hero (ADR-215, ADR-222)
        """
        # GIVEN — the native WeasyPrint call is swapped for a capture of the rendered HTML.
        from margen_api.service_layer import receivable_statement

        rendered: list[str] = []

        def _capture(html: str) -> bytes:
            rendered.append(html)
            return b"%PDF-1.7 stub\n"

        monkeypatch.setattr(receivable_statement, "_html_to_pdf", _capture)
        person_id = await _person(client)
        item = await _add_item(
            client, person_id, amount="4000", detail="TV", installments={"count": 4, "firstDueOn": "2026-06-10"}
        )
        first_cuota = item["installments"][0]["id"]
        paid = await _pay(client, person_id, [{"itemId": item["id"], "installmentId": first_cuota, "amount": "1000"}])
        assert paid.status_code == status.HTTP_201_CREATED, paid.text
        pardoned = await client.post(f"{PEOPLE}/{person_id}/items/{item['id']}/installments/2/pardon")
        assert pardoned.status_code == status.HTTP_200_OK, pardoned.text

        # WHEN
        default = await client.get(f"{PEOPLE}/{person_id}/pdf")
        full = await client.get(f"{PEOPLE}/{person_id}/pdf", params={"lang": "en", "full": "true"})

        # THEN — both render.
        assert default.status_code == full.status_code == status.HTTP_200_OK
        assert default.content.startswith(b"%PDF")
        outstanding_html, full_html = rendered
        # AND — by default only the due cuota is a row, closing on the due-only hero.
        assert '<td class="c-detail">TV · Cuota 3/4</td>' in outstanding_html
        assert "Cuota 1/4" not in outstanding_html  # paid.
        assert "Cuota 4/4" not in outstanding_html  # upcoming: only in the strip's total.
        assert '1.000<span class="frac">,00</span>' in outstanding_html  # the hero.
        assert '<td class="c-bal total">1.000,00</td>' in outstanding_html
        assert _running_balances(outstanding_html)[-1] == "1.000,00"
        assert '<div class="upcoming">' in outstanding_html
        assert "Próximas cuotas" in outstanding_html
        assert "TV · Cuota 2/4" in outstanding_html  # the forgiven cuota, in the covered box.
        # AND — the full history lists every cuota with its status and still closes on the hero.
        for fragment in (
            'TV · Installment 1/4<span class="tag tag-paid">Paid</span>',
            'TV · Installment 2/4<span class="tag tag-pardoned">Forgiven</span>',
            'TV · Installment 3/4<span class="tag tag-due">Due</span>',
            'TV · Installment 4/4<span class="tag tag-upcoming">Upcoming</span>',
            "Upcoming installments",
            '<td class="c-bal total">1,000.00</td>',
        ):
            assert fragment in full_html, fragment
        # Upcoming and forgiven cuotas leave the Saldo cell empty; the last running one is the hero.
        assert _running_balances(full_html) == ["1,000.00", "2,000.00", "1,000.00"]


class TestCuotaPayments:
    """Paying cuotas, oldest first by default (ADR-215, ADR-221)."""

    async def test_suggestion_fills_due_cuotas_oldest_first_and_payment_settles_them(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan (2000 due)
        WHEN 1500 is suggested, then paid exactly as suggested
        THEN the suggestion is cuota 1 (1000) then cuota 2 (500), never the upcoming cuota 3;
             after paying, cuota 1 is paid, cuota 2 owes 500 and the outstanding is 500
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        first, second, _third = item["installments"]

        # WHEN
        response = await client.get(f"{PEOPLE}/{person_id}/suggested-allocation", params={"amount": "1500"})

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        suggestion = response.json()["data"]
        assert suggestion["asOf"] == "2026-08-10"
        assert suggestion["allocations"] == [
            {"itemId": item["id"], "installmentId": first["id"], "amount": "1000.00"},
            {"itemId": item["id"], "installmentId": second["id"], "amount": "500.00"},
        ]
        assert (suggestion["allocated"], suggestion["unallocated"]) == ("1500.00", "0.00")

        # WHEN — the payment is recorded exactly as suggested.
        paid = await _pay(client, person_id, suggestion["allocations"])

        # THEN
        assert paid.status_code == status.HTTP_201_CREATED, paid.text
        detail = paid.json()["data"]
        cuotas = detail["items"][0]["installments"]
        assert [cuota["status"] for cuota in cuotas] == ["paid", "due", "upcoming"]
        assert [cuota["paid"] for cuota in cuotas] == ["1000.00", "500.00", "0"]
        assert detail["outstanding"] == "500.00"
        assert detail["upcomingTotal"] == "1000.00"

        # AND — a larger suggestion now only has the 500 left on cuota 2 to fill.
        rest = (await client.get(f"{PEOPLE}/{person_id}/suggested-allocation", params={"amount": "2000"})).json()[
            "data"
        ]
        assert [line["amount"] for line in rest["allocations"]] == ["500.00"]
        assert rest["unallocated"] == "1500.00"

    async def test_paying_the_upcoming_cuota_needs_confirmation(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan (2000 due, 1000 upcoming)
        WHEN the whole 3000 is paid across the three cuotas, without then with allowOverpayment
        THEN the first try is the 409 overpayment warning against the due 2000, and the
             confirmed retry settles every cuota (ADR-215, ADR-216 early payoff)
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        allocations = [
            {"itemId": item["id"], "installmentId": cuota["id"], "amount": "1000"} for cuota in item["installments"]
        ]

        # WHEN
        warned = await _pay(client, person_id, allocations)
        confirmed = await _pay(client, person_id, allocations, allowOverpayment=True)

        # THEN
        assert warned.status_code == status.HTTP_409_CONFLICT
        assert warned.json()["detail"] == {
            "code": "receivable_overpayment",
            "outstanding": "2000.00",
            "requested": "3000",
        }
        assert confirmed.status_code == status.HTTP_201_CREATED, confirmed.text
        cuotas = confirmed.json()["data"]["items"][0]["installments"]
        assert [cuota["status"] for cuota in cuotas] == ["paid", "paid", "paid"]

    async def test_cuota_targeting_errors(self, client: httpx.AsyncClient):
        """
        GIVEN an installment item, a flat item, and a pardoned cuota
        WHEN payments target the plan without a cuota, the flat item with a cuota, an unknown
             cuota, or the pardoned cuota
        THEN they answer 422, 422, 404 and 404 respectively and record nothing
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        flat = await _add_item(client, person_id, occurredOn="2026-07-20", amount="500", installments=None)
        await client.post(f"{PEOPLE}/{person_id}/items/{item['id']}/installments/1/pardon")
        first_id = item["installments"][0]["id"]

        # WHEN
        cases = [
            [{"itemId": item["id"], "amount": "100"}],
            [{"itemId": flat["id"], "installmentId": first_id, "amount": "100"}],
            [{"itemId": item["id"], "installmentId": _MISSING_ID, "amount": "100"}],
            [{"itemId": item["id"], "installmentId": first_id, "amount": "100"}],
        ]
        codes = [(await _pay(client, person_id, allocations)).status_code for allocations in cases]

        # THEN
        assert codes == [422, 422, 404, 404]
        assert all(cuota["paid"] == "0" for cuota in (await _detail(client, person_id))["items"][1]["installments"])

    async def test_suggestion_for_unknown_person_or_bad_amount(self, client: httpx.AsyncClient):
        """
        GIVEN no person with the requested id, and a real person
        WHEN a suggestion is requested for the unknown person, or with a non-positive amount
        THEN they answer 404 and 422
        """
        person_id = await _person(client)
        missing = await client.get(f"{PEOPLE}/{_MISSING_ID}/suggested-allocation", params={"amount": "10"})
        bad = await client.get(f"{PEOPLE}/{person_id}/suggested-allocation", params={"amount": "0"})
        assert (missing.status_code, bad.status_code) == (404, 422)


class TestPlanEdits:
    """Editing cuotas and re-shaping the plan, locked once paid (ADR-216)."""

    async def test_edit_one_cuota_rederives_the_item_amount(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan
        WHEN cuota 3 gets a recargo (1200) and a later due date
        THEN cuota 3 changes and the item amount becomes 3200
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)

        # WHEN
        response = await client.patch(
            f"{PEOPLE}/{person_id}/items/{item['id']}/installments/3",
            json={"amount": "1200", "dueOn": "2026-10-15"},
        )

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        edited = response.json()["data"]["items"][0]
        assert edited["amount"] == "3200.00"
        assert (edited["installments"][2]["amount"], edited["installments"][2]["dueOn"]) == ("1200.00", "2026-10-15")

    async def test_cuota_edit_errors(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan
        WHEN cuota 9 is edited, cuota 0 is addressed, or an amount rounds to zero cents
        THEN they answer 404, 422 and 422
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        base = f"{PEOPLE}/{person_id}/items/{item['id']}/installments"
        unknown = await client.patch(f"{base}/9", json={"amount": "1"})
        zero_index = await client.patch(f"{base}/0", json={"amount": "1"})
        zero_cents = await client.patch(f"{base}/1", json={"amount": "0.001"})
        assert (unknown.status_code, zero_index.status_code, zero_cents.status_code) == (404, 422, 422)

    async def test_unpaid_plan_reshapes_converts_and_keeps_edits_on_resend(self, client: httpx.AsyncClient):
        """
        GIVEN an unpaid 3-cuota item
        WHEN it is re-planned to 6 cuotas, then turned flat, then re-planned to 2 cuotas over
             a new total, then cuota 2 is edited and the same plan re-sent
        THEN each step re-derives the schedule (old cuota indexes are replaced without
             tripping the unique constraint) and the final re-send keeps the cuota edit
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        url = f"{PEOPLE}/{person_id}/items/{item['id']}"

        # WHEN / THEN — 6 cuotas.
        six = await client.patch(url, json={"installments": {"count": 6, "firstDueOn": "2026-07-10"}})
        assert six.status_code == status.HTTP_200_OK, six.text
        assert [cuota["amount"] for cuota in six.json()["data"]["items"][0]["installments"]] == ["500.00"] * 6

        # WHEN / THEN — flat again.
        flat = await client.patch(url, json={"installments": None})
        assert flat.json()["data"]["items"][0]["installments"] == []
        assert flat.json()["data"]["outstanding"] == "3000.00"

        # WHEN / THEN — 2 cuotas over a new total.
        two = await client.patch(url, json={"amount": "1000", "installments": {"count": 2, "firstDueOn": "2026-08-01"}})
        assert [cuota["amount"] for cuota in two.json()["data"]["items"][0]["installments"]] == ["500.00", "500.00"]

        # WHEN — cuota 2 edited, then the same plan re-sent with a new detail.
        await client.patch(f"{url}/installments/2", json={"amount": "650"})
        resent = await client.patch(
            url, json={"detail": "same plan", "installments": {"count": 2, "firstDueOn": "2026-08-01"}}
        )

        # THEN — the edit survives.
        kept = resent.json()["data"]["items"][0]
        assert kept["detail"] == "same plan"
        assert [cuota["amount"] for cuota in kept["installments"]] == ["500.00", "650.00"]

    async def test_plan_is_locked_once_a_cuota_is_paid(self, client: httpx.AsyncClient):
        """
        GIVEN a 3-cuota item with cuota 1 paid
        WHEN the plan count changes, the plan is removed, or the total changes
        THEN each answers 409 installment_schedule_locked (reason: allocations) and the plan
             is unchanged (ADR-216)
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        await _pay(
            client,
            person_id,
            [{"itemId": item["id"], "installmentId": item["installments"][0]["id"], "amount": "1000"}],
        )
        url = f"{PEOPLE}/{person_id}/items/{item['id']}"

        # WHEN
        responses = [
            await client.patch(url, json={"installments": {"count": 6, "firstDueOn": "2026-07-10"}}),
            await client.patch(url, json={"installments": None}),
            await client.patch(url, json={"amount": "4000"}),
        ]

        # THEN
        for response in responses:
            assert response.status_code == status.HTTP_409_CONFLICT, response.text
            assert response.json()["detail"] == {
                "code": "installment_schedule_locked",
                "itemId": item["id"],
                "reason": "allocations",
            }
        assert len((await _detail(client, person_id))["items"][0]["installments"]) == 3

    async def test_pardons_lock_the_plan_too(self, client: httpx.AsyncClient):
        """
        GIVEN a 3-cuota item with cuota 2 pardoned
        WHEN the plan count changes
        THEN it answers 409 with reason pardons (un-pardon first)
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        await client.post(f"{PEOPLE}/{person_id}/items/{item['id']}/installments/2/pardon")
        response = await client.patch(
            f"{PEOPLE}/{person_id}/items/{item['id']}", json={"installments": {"count": 2, "firstDueOn": "2026-07-10"}}
        )
        assert response.status_code == status.HTTP_409_CONFLICT
        assert response.json()["detail"]["reason"] == "pardons"


class TestCuotaPardons:
    """Pardon a single cuota, or the whole remaining plan via the item (ADR-221)."""

    async def test_single_cuota_pardon_and_unpardon(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan (2000 due)
        WHEN cuota 2 is pardoned, then un-pardoned
        THEN it drops out of the outstanding (1000) as 'pardoned', then comes back (2000)
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        base = f"{PEOPLE}/{person_id}/items/{item['id']}/installments/2"

        # WHEN
        pardoned = (await client.post(f"{base}/pardon")).json()["data"]
        restored = (await client.post(f"{base}/unpardon")).json()["data"]

        # THEN
        assert pardoned["outstanding"] == "1000.00"
        assert pardoned["items"][0]["installments"][1]["status"] == "pardoned"
        assert pardoned["items"][0]["pardoned"] is False
        assert restored["outstanding"] == "2000.00"
        assert restored["items"][0]["installments"][1]["status"] == "due"

    async def test_item_pardon_forgives_the_remaining_plan(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan with cuota 1 paid
        WHEN the item is pardoned, then un-pardoned
        THEN cuotas 2-3 become pardoned (cuota 1 stays paid), the item reads as pardoned and
             nothing is owed or upcoming; the un-pardon restores 1000 due + 1000 upcoming
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        await _pay(
            client,
            person_id,
            [{"itemId": item["id"], "installmentId": item["installments"][0]["id"], "amount": "1000"}],
        )

        # WHEN
        forgiven = (await client.post(f"{PEOPLE}/{person_id}/items/{item['id']}/pardon")).json()["data"]
        restored = (await client.post(f"{PEOPLE}/{person_id}/items/{item['id']}/unpardon")).json()["data"]

        # THEN
        assert [cuota["status"] for cuota in forgiven["items"][0]["installments"]] == ["paid", "pardoned", "pardoned"]
        assert forgiven["items"][0]["pardoned"] is True
        assert (forgiven["outstanding"], forgiven["upcomingTotal"]) == ("0.00", "0")
        assert (restored["outstanding"], restored["upcomingTotal"]) == ("1000.00", "1000.00")

    async def test_unknown_cuota_or_foreign_item_is_404(
        self,
        client: httpx.AsyncClient,
        fk_container: ApplicationContainer,
        client_for_user,
    ):
        """
        GIVEN user A's 3-cuota item
        WHEN A pardons cuota 9, or user B pardons cuota 1
        THEN both answer 404 (ADR-111)
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        base = f"{PEOPLE}/{person_id}/items/{item['id']}/installments"
        assert (await client.post(f"{base}/9/pardon")).status_code == status.HTTP_404_NOT_FOUND
        async with client_for_user(fk_container, STUB_AUTH_USER_B) as client_b:
            assert (await client_b.post(f"{base}/1/unpardon")).status_code == status.HTTP_404_NOT_FOUND


class TestExpenseLink:
    """The optional, reference-only link from an item to an expense (ADR-217..220)."""

    async def test_cuota_expense_is_compared_on_its_whole_plan(self, client: httpx.AsyncClient):
        """
        GIVEN a 9000 card-cuota expense (cuota 2 of 6, so a 54000 purchase)
        WHEN Juan's 6000 item and Ana's 4000 item link it, then a 50000 item links it too
        THEN each item carries the expense summary with planTotal 54000; at 10000 linked there is
             no over-split warning (no false positive against the single cuota), at 60000 there is
             (ADR-218, non-blocking)
        """
        # GIVEN
        expense_id = await _expense(client, recurringCadence="installment", installmentsTotal=6, installmentsIndex=2)
        juan = await _person(client, "Juan")
        ana = await _person(client, "Ana")

        # WHEN
        juan_item = await _add_item(client, juan, amount="6000", installments=None, sourceTransactionId=expense_id)
        ana_item = await _add_item(client, ana, amount="4000", installments=PLAN, sourceTransactionId=expense_id)

        # THEN
        assert juan_item["sourceTransaction"] == {
            "id": expense_id,
            "name": "Cena",
            "occurredOn": "2026-07-01",
            "amount": "9000.00",
            "currency": "ARS",
            "usdAmount": None,
            "installmentsIndex": 2,
            "installmentsTotal": 6,
            "planTotal": "54000.00",
            "linkedItemsTotal": "6000.00",
        }
        assert ana_item["sourceTransaction"]["linkedItemsTotal"] == "10000.00"
        assert ana_item["linkedTotalExceedsExpense"] is False

        # WHEN — a third item pushes the linked total past the whole plan.
        too_much = await _add_item(
            client, ana, occurredOn="2026-07-02", amount="50000", installments=None, sourceTransactionId=expense_id
        )

        # THEN
        assert too_much["linkedTotalExceedsExpense"] is True
        assert (await _detail(client, juan))["items"][0]["linkedTotalExceedsExpense"] is True

    async def test_flat_expense_is_compared_on_its_amount(self, client: httpx.AsyncClient):
        """
        GIVEN a 9000 expense that is not a card cuota
        WHEN 6000, then another 4000, of items link it
        THEN planTotal is the amount itself and the warning turns on once 10000 > 9000 (ADR-218)
        """
        # GIVEN
        expense_id = await _expense(client)
        juan = await _person(client, "Juan")
        ana = await _person(client, "Ana")

        # WHEN
        first = await _add_item(client, juan, amount="6000", installments=None, sourceTransactionId=expense_id)
        second = await _add_item(client, ana, amount="4000", installments=None, sourceTransactionId=expense_id)

        # THEN
        assert first["sourceTransaction"]["planTotal"] == "9000.00"
        assert first["linkedTotalExceedsExpense"] is False
        assert second["linkedTotalExceedsExpense"] is True

    async def test_patch_links_and_unlinks(self, client: httpx.AsyncClient):
        """
        GIVEN a flat item and one of the owner's expenses
        WHEN the item is patched with the expense id, then with null
        THEN the summary appears, then disappears
        """
        # GIVEN
        expense_id = await _expense(client)
        person_id = await _person(client)
        item = await _add_item(client, person_id, installments=None)
        url = f"{PEOPLE}/{person_id}/items/{item['id']}"

        # WHEN
        linked = await client.patch(url, json={"sourceTransactionId": expense_id})
        unlinked = await client.patch(url, json={"sourceTransactionId": None})

        # THEN
        assert linked.json()["data"]["items"][0]["sourceTransaction"]["id"] == expense_id
        assert unlinked.json()["data"]["items"][0]["sourceTransaction"] is None

    async def test_link_guard_rejects_income_foreign_and_unknown_transactions(
        self,
        client: httpx.AsyncClient,
        fk_container: ApplicationContainer,
        client_for_user,
    ):
        """
        GIVEN an income of the owner, an expense of user B, and an unknown id
        WHEN an item is created (or patched) linking each
        THEN every attempt answers 404 without leaking which case applied (ADR-217, ADR-111)
        """
        # GIVEN
        income_id = await _expense(client, name="Sueldo", kind="income")
        async with client_for_user(fk_container, STUB_AUTH_USER_B) as client_b:
            foreign_id = await _expense(client_b, name="Ajeno")
        person_id = await _person(client)
        flat = await _add_item(client, person_id, installments=None)

        # WHEN
        created = [
            await client.post(
                f"{PEOPLE}/{person_id}/items",
                json={"occurredOn": "2026-07-02", "amount": "100", "sourceTransactionId": target},
            )
            for target in (income_id, foreign_id, _MISSING_ID)
        ]
        patched = await client.patch(
            f"{PEOPLE}/{person_id}/items/{flat['id']}", json={"sourceTransactionId": income_id}
        )

        # THEN
        assert [response.status_code for response in created] == [404, 404, 404]
        assert patched.status_code == status.HTTP_404_NOT_FOUND
        assert "Source expense transaction" in patched.json()["detail"]

    async def test_linking_never_moves_net_worth_or_budget_spend(self, client: httpx.AsyncClient):
        """
        GIVEN an account and a past Social expense on it, with the baseline net worth and
              budget read
        WHEN two people's installment items link the expense, cuotas are paid, edited and pardoned
        THEN net worth and the month's budget surface are identical to the baseline — the link is
             reference-only and receivables never touch balances (ADR-205, ADR-219)
        """
        # GIVEN
        past = datetime.now(UTC).date() - timedelta(days=30)
        month = f"{past.year:04d}-{past.month:02d}"
        institution = await client.post(INSTITUTIONS, json={"name": "Galicia", "type": "bank"})
        account = await client.post(
            ACCOUNTS,
            json={"institutionId": institution.json()["data"]["id"], "currency": "ARS", "openingBalance": "50000"},
        )
        expense_id = await _expense(
            client,
            occurredOn=past.isoformat(),
            amount="12000",
            category="Social",
            accountId=account.json()["data"]["id"],
        )
        net_worth_before = (await client.get(NET_WORTH)).json()["data"]
        budget_before = (await client.get(BUDGETS, params={"month": month})).json()["data"]
        assert net_worth_before["total"] == "38000.00"

        # WHEN
        juan = await _person(client, "Juan")
        ana = await _person(client, "Ana")
        item = await _add_item(client, juan, amount="6000", sourceTransactionId=expense_id)
        await _add_item(client, ana, amount="6000", installments=None, sourceTransactionId=expense_id)
        await _pay(
            client,
            juan,
            [{"itemId": item["id"], "installmentId": item["installments"][0]["id"], "amount": "2000"}],
        )
        await client.patch(f"{PEOPLE}/{juan}/items/{item['id']}/installments/2", json={"amount": "2500"})
        await client.post(f"{PEOPLE}/{juan}/items/{item['id']}/installments/3/pardon")

        # THEN
        assert (await client.get(NET_WORTH)).json()["data"] == net_worth_before
        assert (await client.get(BUDGETS, params={"month": month})).json()["data"] == budget_before


class TestExpenseCandidates:
    """The owner-scoped expense picker behind the link (ADR-220)."""

    async def test_lists_only_the_owners_expenses_newest_first_with_linked_totals(
        self,
        client: httpx.AsyncClient,
        fk_container: ApplicationContainer,
        client_for_user,
    ):
        """
        GIVEN three of the owner's expenses (one linked by a 2500 item), one income, and an
              expense of user B
        WHEN the candidates are listed
        THEN only the owner's three expenses come back, newest first, the linked one carrying
             linkedItemsTotal 2500 and the others 0
        """
        # GIVEN
        old = await _expense(client, name="Supermercado", occurredOn="2026-05-01")
        mid = await _expense(client, name="Cena con amigos", occurredOn="2026-06-01", amount="6000")
        new = await _expense(client, name="Nafta", occurredOn="2026-07-01")
        await _expense(client, name="Sueldo", kind="income", occurredOn="2026-07-02")
        async with client_for_user(fk_container, STUB_AUTH_USER_B) as client_b:
            await _expense(client_b, name="Cena ajena", occurredOn="2026-07-03")
        person_id = await _person(client)
        await _add_item(client, person_id, amount="2500", installments=None, sourceTransactionId=mid)

        # WHEN
        response = await client.get(CANDIDATES)

        # THEN
        assert response.status_code == status.HTTP_200_OK, response.text
        candidates = response.json()["data"]
        assert [candidate["id"] for candidate in candidates] == [new, mid, old]
        assert [candidate["linkedItemsTotal"] for candidate in candidates] == ["0", "2500.00", "0"]
        assert candidates[1]["name"] == "Cena con amigos"
        assert candidates[1]["amount"] == "6000.00"

    async def test_filters_by_name_and_dates_and_limits(self, client: httpx.AsyncClient):
        """
        GIVEN expenses named Cena (Jun), CENA familiar (Jul) and Nafta (Jul)
        WHEN filtered by q=cena, by a date window, and by limit=1
        THEN the name match is case-insensitive, the window is inclusive, and limit caps the list
        """
        # GIVEN
        june = await _expense(client, name="Cena", occurredOn="2026-06-15")
        july = await _expense(client, name="CENA familiar", occurredOn="2026-07-15")
        nafta = await _expense(client, name="Nafta", occurredOn="2026-07-20")

        # WHEN
        by_name = (await client.get(CANDIDATES, params={"q": " cena "})).json()["data"]
        by_dates = (await client.get(CANDIDATES, params={"from": "2026-07-15", "to": "2026-07-20"})).json()["data"]
        limited = (await client.get(CANDIDATES, params={"limit": 1})).json()["data"]
        nothing = (await client.get(CANDIDATES, params={"q": "zzz"})).json()["data"]

        # THEN
        assert [candidate["id"] for candidate in by_name] == [july, june]
        assert [candidate["id"] for candidate in by_dates] == [nafta, july]
        assert [candidate["id"] for candidate in limited] == [nafta]
        assert nothing == []

    @pytest.mark.parametrize("limit", [0, 51])
    async def test_limit_is_bounded(self, client: httpx.AsyncClient, limit: int):
        """
        GIVEN a limit outside 1..50
        WHEN the candidates are requested
        THEN it answers 422
        """
        response = await client.get(CANDIDATES, params={"limit": limit})
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestItemRoutesAreScopedToTheirPerson:
    """An item addressed through the wrong person is a 404, never a stray write (ADR-111)."""

    async def test_another_persons_url_cannot_reach_the_item(self, client: httpx.AsyncClient):
        """
        GIVEN Juan's 3-cuota item and another person, Ana, of the same owner
        WHEN every item and cuota write addresses Juan's item through Ana's URL
        THEN each answers 404 and Juan's item is unchanged
        """
        # GIVEN
        juan = await _person(client, "Juan")
        ana = await _person(client, "Ana")
        item = await _add_item(client, juan)
        base = f"{PEOPLE}/{ana}/items/{item['id']}"

        # WHEN
        responses = [
            await client.patch(base, json={"detail": "stray"}),
            await client.patch(f"{base}/installments/1", json={"amount": "1"}),
            await client.post(f"{base}/installments/1/pardon"),
            await client.post(f"{base}/installments/1/unpardon"),
            await client.post(f"{base}/pardon"),
            await client.post(f"{base}/unpardon"),
            await client.delete(base),
        ]

        # THEN
        assert [response.status_code for response in responses] == [404] * len(responses)
        unchanged = (await _detail(client, juan))["items"][0]
        assert unchanged["detail"] is None
        assert [cuota["amount"] for cuota in unchanged["installments"]] == ["1000.00"] * 3
        assert not any(cuota["pardoned"] for cuota in unchanged["installments"])

    async def test_an_unknown_person_url_is_a_404(self, client: httpx.AsyncClient):
        """
        GIVEN an item of a real person
        WHEN it is patched or deleted through an unknown person id
        THEN both answer 404 (previously the write went through and the read-back failed)
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        base = f"{PEOPLE}/{_MISSING_ID}/items/{item['id']}"
        patched = await client.patch(base, json={"detail": "stray"})
        deleted = await client.delete(base)
        assert (patched.status_code, deleted.status_code) == (404, 404)
        assert (await _detail(client, person_id))["items"][0]["id"] == item["id"]


class TestIdempotentCreate:
    """``POST .../items`` with a client id is safe to retry; cuota tweaks apply atomically (ADR-216)."""

    def _body(self, item_id: str, amount: str = "3000") -> dict[str, object]:
        return {
            "id": item_id,
            "occurredOn": "2026-07-01",
            "amount": amount,
            "installments": {
                "count": 3,
                "firstDueOn": "2026-07-10",
                "cuotas": [{"index": 3, "amount": "1500", "dueOn": "2026-10-01"}],
            },
        }

    async def test_a_retry_with_the_same_id_returns_the_same_item(self, client: httpx.AsyncClient):
        """
        GIVEN a create request carrying a client id and a tweak raising cuota 3 to 1500
        WHEN it is sent twice
        THEN both answer 201 with that createdItemId, the person has ONE item, and its schedule
             already carries the tweak (1000 / 1000 / 1500, total 3500)
        """
        # GIVEN
        person_id = await _person(client)
        item_id = str(uuid4())

        # WHEN
        first = await client.post(f"{PEOPLE}/{person_id}/items", json=self._body(item_id))
        second = await client.post(f"{PEOPLE}/{person_id}/items", json=self._body(item_id))

        # THEN
        assert (first.status_code, second.status_code) == (201, 201), second.text
        assert first.json()["data"]["createdItemId"] == second.json()["data"]["createdItemId"] == item_id
        (item,) = second.json()["data"]["items"]
        assert [cuota["amount"] for cuota in item["installments"]] == ["1000.00", "1000.00", "1500.00"]
        assert item["installments"][2]["dueOn"] == "2026-10-01"
        assert item["amount"] == "3500.00"

    async def test_the_same_id_with_other_terms_is_a_conflict(self, client: httpx.AsyncClient):
        """
        GIVEN an item created with a client id
        WHEN another create reuses the id with a different amount
        THEN it answers 409 item_id_conflict and nothing changes
        """
        # GIVEN
        person_id = await _person(client)
        item_id = str(uuid4())
        await client.post(f"{PEOPLE}/{person_id}/items", json=self._body(item_id))

        # WHEN
        response = await client.post(f"{PEOPLE}/{person_id}/items", json=self._body(item_id, amount="4000"))

        # THEN
        assert response.status_code == status.HTTP_409_CONFLICT
        assert response.json()["detail"] == {"code": "item_id_conflict", "itemId": item_id}
        assert (await _detail(client, person_id))["items"][0]["amount"] == "3500.00"

    @pytest.mark.parametrize(
        "cuotas",
        [
            [{"index": 4, "amount": "10"}],
            [{"index": 2, "amount": "10"}, {"index": 2, "dueOn": "2026-09-01"}],
            [{"index": 1, "amount": "0.001"}],
            [{"index": 0, "amount": "10"}],
        ],
        ids=["index-out-of-plan", "index-twice", "amount-rounds-to-zero", "index-zero"],
    )
    async def test_invalid_cuota_tweaks_are_rejected_and_nothing_is_created(
        self, client: httpx.AsyncClient, cuotas: list[dict]
    ):
        """
        GIVEN cuota tweaks naming a cuota the plan lacks, one cuota twice, a zero amount, or index 0
        WHEN the item is created
        THEN it answers 422 and the person has no item
        """
        person_id = await _person(client)
        body = {"occurredOn": "2026-07-01", "amount": "3000", "installments": {**PLAN, "cuotas": cuotas}}
        response = await client.post(f"{PEOPLE}/{person_id}/items", json=body)
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, response.text
        assert (await _detail(client, person_id))["items"] == []


class TestPerTargetOverpayment:
    """Paying one item or cuota beyond what it owes is a confirmable 409 (ADR-206, ADR-221)."""

    async def test_overrunning_a_cuota_needs_confirmation(self, client: httpx.AsyncClient):
        """
        GIVEN the 3-cuota plan with 2000 due
        WHEN 1500 is allocated to cuota 1 alone, then confirmed with allowOverpayment
        THEN the first answer is 409 allocation_exceeds_target (cuota 1 owes 1000), and the
             confirmed one records it: cuota 1 is paid with a -500 remainder, a credit that
             leaves 500 outstanding
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        first = item["installments"][0]["id"]
        allocation = [{"itemId": item["id"], "installmentId": first, "amount": "1500"}]

        # WHEN
        warned = await _pay(client, person_id, allocation)
        confirmed = await _pay(client, person_id, allocation, allowOverpayment=True)

        # THEN
        assert warned.status_code == status.HTTP_409_CONFLICT
        assert warned.json()["detail"] == {
            "code": "allocation_exceeds_target",
            "itemId": item["id"],
            "installmentId": first,
            "remaining": "1000.00",
            "requested": "1500",
        }
        assert confirmed.status_code == status.HTTP_201_CREATED, confirmed.text
        detail = confirmed.json()["data"]
        assert detail["items"][0]["installments"][0]["remaining"] == "-500.00"
        assert detail["outstanding"] == "500.00"

    async def test_overrunning_a_flat_item_needs_confirmation(self, client: httpx.AsyncClient):
        """
        GIVEN a flat 500 item next to the plan
        WHEN 800 is allocated to the flat item
        THEN it answers 409 allocation_exceeds_target without an installmentId
        """
        person_id = await _person(client)
        await _add_item(client, person_id)
        flat = await _add_item(client, person_id, occurredOn="2026-07-20", amount="500", installments=None)
        warned = await _pay(client, person_id, [{"itemId": flat["id"], "amount": "800"}])
        assert warned.status_code == status.HTTP_409_CONFLICT
        assert (warned.json()["detail"]["installmentId"], warned.json()["detail"]["remaining"]) == (None, "500.00")

    async def test_a_credit_caps_the_suggestion_so_it_posts_cleanly(self, client: httpx.AsyncClient):
        """
        GIVEN a flat 500 item confirmed-overpaid with 800 (a 300 credit) next to the plan (2000 due)
        WHEN 5000 is suggested and the suggestion is posted back
        THEN only the 1700 owed overall is suggested and the payment records without any 409
        """
        # GIVEN
        person_id = await _person(client)
        await _add_item(client, person_id)
        flat = await _add_item(client, person_id, occurredOn="2026-07-20", amount="500", installments=None)
        await _pay(client, person_id, [{"itemId": flat["id"], "amount": "800"}], allowOverpayment=True)

        # WHEN
        response = await client.get(f"{PEOPLE}/{person_id}/suggested-allocation", params={"amount": "5000"})
        suggestion = response.json()["data"]
        posted = await _pay(client, person_id, suggestion["allocations"])

        # THEN
        assert (suggestion["allocated"], suggestion["unallocated"]) == ("1700.00", "3300.00")
        assert posted.status_code == status.HTTP_201_CREATED, posted.text


class TestCuotaFloor:
    """A paid cuota cannot be edited below what was paid toward it (ADR-216)."""

    async def test_editing_below_the_payment_is_a_422_with_the_paid_amount(self, client: httpx.AsyncClient):
        """
        GIVEN cuota 1 fully paid (1000)
        WHEN it is edited to 400
        THEN it answers 422 installment_amount_below_paid carrying what was paid
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        first = item["installments"][0]["id"]
        await _pay(client, person_id, [{"itemId": item["id"], "installmentId": first, "amount": "1000"}])
        response = await client.patch(f"{PEOPLE}/{person_id}/items/{item['id']}/installments/1", json={"amount": "400"})
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert response.json()["detail"] == {
            "code": "installment_amount_below_paid",
            "itemId": item["id"],
            "index": 1,
            "paid": "1000.00",
            "amount": "400.00",
        }


class TestDateBounds:
    """Request dates outside 2000..2100 are rejected at the boundary, never a 500."""

    @pytest.mark.parametrize(
        ("target", "body"),
        [
            ("items", {"occurredOn": "9999-01-01", "amount": "100"}),
            (
                "items",
                {"occurredOn": "2026-07-01", "amount": "100", "installments": {"count": 2, "firstDueOn": "9999-12-31"}},
            ),
            (
                "items",
                {
                    "occurredOn": "2026-07-01",
                    "amount": "100",
                    "installments": {**PLAN, "cuotas": [{"index": 1, "dueOn": "1999-12-31"}]},
                },
            ),
            (
                "payments",
                {"occurredOn": "2101-01-01", "amount": "1", "allocations": [{"itemId": _MISSING_ID, "amount": "1"}]},
            ),
        ],
        ids=["item-date", "first-due-date", "cuota-due-date", "payment-date"],
    )
    async def test_out_of_range_dates_are_a_422(self, client: httpx.AsyncClient, target: str, body: dict):
        """
        GIVEN a create body with a date far outside 2000..2100
        WHEN it is posted
        THEN it answers 422
        """
        person_id = await _person(client)
        response = await client.post(f"{PEOPLE}/{person_id}/{target}", json=body)
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    async def test_patch_dates_are_bounded_too(self, client: httpx.AsyncClient):
        """
        GIVEN an installment item
        WHEN the item date or a cuota due date is patched to year 9999
        THEN both answer 422
        """
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        url = f"{PEOPLE}/{person_id}/items/{item['id']}"
        patched_item = await client.patch(url, json={"occurredOn": "9999-01-01"})
        patched_cuota = await client.patch(f"{url}/installments/1", json={"dueOn": "9999-01-01"})
        assert (patched_item.status_code, patched_cuota.status_code) == (422, 422)


class TestInconsistentRowsDoNotBreakReads:
    """A stored amount that disagrees with its cuotas is read as the cuota sum (ADR-216)."""

    async def test_a_stale_amount_reads_as_the_cuota_sum_and_the_next_write_repairs_it(
        self,
        client: httpx.AsyncClient,
        fk_container: ApplicationContainer,
    ):
        """
        GIVEN a 3000 installment item whose stored amount was left at 1234 (e.g. by an old race)
        WHEN the person and the people list are read, then the item is patched
        THEN both reads succeed with the cuota sum (3000.00), and the patch stores it back
        """
        # GIVEN
        person_id = await _person(client)
        item = await _add_item(client, person_id)
        session = fk_container.session_factory()
        try:
            record = await session.get(ReceivableItemRecord, UUID(item["id"]))
            assert record is not None
            record.amount = Decimal("1234")
            await session.commit()
        finally:
            await session.close()

        # WHEN
        detail = await client.get(f"{PEOPLE}/{person_id}")
        listed = await client.get(PEOPLE)
        patched = await client.patch(f"{PEOPLE}/{person_id}/items/{item['id']}", json={"detail": "fixed"})

        # THEN
        assert detail.status_code == listed.status_code == patched.status_code == status.HTTP_200_OK
        assert detail.json()["data"]["items"][0]["amount"] == "3000.00"
        assert listed.json()["data"][0]["outstanding"] == "2000.00"
        session = fk_container.session_factory()
        try:
            repaired = await session.get(ReceivableItemRecord, UUID(item["id"]))
            assert repaired is not None
            assert repaired.amount == Decimal("3000.00")
        finally:
            await session.close()
