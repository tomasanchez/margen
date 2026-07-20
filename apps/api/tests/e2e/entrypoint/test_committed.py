"""Route tests for the committed-spend accent entrypoint (ADR-179).

Two tiers cover ``GET /reports/committed``:

* The envelope / contract / validation tier drives the endpoint with the committed
  reader **mocked** to a :class:`FakeCommittedReader` (ADR-032): it asserts the ``{data}``
  envelope, camelCase fields (paid/pending/bySource/unconverted), the month/currency
  forwarding and defaults, and the ``422`` boundary validation - not the committed SQL.
* The DB-backed tier drives the **REAL** container on in-memory async SQLite (ADR-019)
  so the ``SqlAlchemyCommittedReader`` derives the split for real: paid-only, pending-only,
  the posted-this-month flip, both currencies, plus owner scoping (a second user's
  commitments never leak). Movements are dated in the CURRENT / a PRIOR month so the
  paid/pending state is date-robust regardless of the run date.
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
from margen_api.entrypoint.dependencies import get_committed_reader
from margen_api.service_layer.committed_read_models import CommittedBySource, CommittedSplit
from margen_api.settings.database_settings import DatabaseSettings
from tests.conftest import STUB_AUTH_USER_B, STUB_USER_ID

COMMITTED = "/api/v1/reports/committed"
TRANSACTIONS = "/api/v1/transactions"
SETTINGS = "/api/v1/settings"


def _this_month_key() -> str:
    """Return the current server month as ``YYYY-MM`` (the default target month)."""
    today = datetime.now(UTC).date()
    return f"{today.year:04d}-{today.month:02d}"


def _today_iso() -> str:
    """Return today's date as an ISO string for a movement in the current month."""
    return date.today().isoformat()


def _prior_month_first_iso() -> str:
    """Return the first day of the PRIOR calendar month as an ISO string."""
    today = datetime.now(UTC).date()
    index = today.year * 12 + (today.month - 1) - 1
    year, month = divmod(index, 12)
    return date(year, month + 1, 1).isoformat()


def _split() -> CommittedSplit:
    """Build a canned committed split exercising paid + pending + the unconverted caveat."""
    return CommittedSplit(
        month="2026-06",
        currency="USD",
        paid=CommittedBySource(
            subscription=Decimal("10.00"),
            installment=Decimal("100.00"),
            tax=Decimal("0.00"),
            total=Decimal("110.00"),
        ),
        pending=CommittedBySource(
            subscription=Decimal("5.00"),
            installment=Decimal("0.00"),
            tax=Decimal("0.00"),
            total=Decimal("5.00"),
        ),
        unconverted=1,
    )


class TestCommittedContract:
    """GET /reports/committed returns the {data} envelope with the split shape (ADR-179)."""

    @pytest.fixture(name="reader")
    def fixture_reader(self):
        """Provide a fake committed reader returning a canned split."""
        from tests.fakes.persistence import FakeCommittedReader

        return FakeCommittedReader(_split())

    @pytest.fixture(name="client")
    async def fixture_client(self, reader) -> AsyncIterator[httpx.AsyncClient]:
        """Build an ASGI client whose committed reader dependency is mocked."""
        container = bootstrap(DatabaseSettings(URL="sqlite+aiosqlite://", AUTO_CREATE_SCHEMA=False))
        app = get_application(container)
        app.dependency_overrides[get_committed_reader] = lambda: reader
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await container.shutdown()

    async def test_returns_envelope_with_paid_pending_by_source(self, client: httpx.AsyncClient, reader):
        """
        GIVEN a mocked reader returning a canned split
        WHEN the committed endpoint is requested for a month + USD currency
        THEN it returns 200 with the {data} envelope, camelCase paid/pending by source,
             the unconverted caveat, and forwards the month/currency scoped to the owner
        """
        # WHEN
        response = await client.get(COMMITTED, params={"month": "2026-06", "currency": "USD"})

        # THEN
        assert response.status_code == status.HTTP_200_OK
        data = response.json()["data"]
        assert data["month"] == "2026-06"
        assert data["currency"] == "USD"
        assert data["unconverted"] == 1
        assert data["paid"] == {
            "subscription": "10.00",
            "installment": "100.00",
            "tax": "0.00",
            "total": "110.00",
        }
        assert data["pending"] == {
            "subscription": "5.00",
            "installment": "0.00",
            "tax": "0.00",
            "total": "5.00",
        }
        # The router forwards the month/currency and scopes to the owner (ADR-108).
        assert reader.requested_month == date(2026, 6, 1)
        assert reader.requested_currency == Currency.USD
        assert reader.requested_user_id == STUB_USER_ID

    async def test_defaults_to_current_month_ars(self, client: httpx.AsyncClient, reader):
        """
        GIVEN no month or currency query params
        WHEN the committed endpoint is requested
        THEN it returns 200 and the reader is asked for the current month in ARS
        """
        # WHEN
        response = await client.get(COMMITTED)

        # THEN
        assert response.status_code == status.HTTP_200_OK
        today = datetime.now(UTC).date()
        assert reader.requested_month == date(today.year, today.month, 1)
        assert reader.requested_currency == Currency.ARS

    @pytest.mark.parametrize("bad_param", [{"month": "2026-13"}, {"month": "not-a-month"}, {"currency": "EUR"}])
    async def test_bad_params_return_422(self, client: httpx.AsyncClient, bad_param: dict):
        """
        GIVEN a malformed month or an out-of-set currency
        WHEN the committed endpoint is requested
        THEN boundary validation returns 422
        """
        # WHEN
        response = await client.get(COMMITTED, params=bad_param)

        # THEN
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


class TestCommittedDbBacked:
    """The REAL committed reader derives the split on the in-memory tier (ADR-179).

    Drives the endpoint through the real container (no reader override) so the
    ``SqlAlchemyCommittedReader`` stream aggregations execute end to end.
    """

    async def _post(self, client: httpx.AsyncClient, *, occurred_on: str | None = None, **body: object) -> str:
        """POST a transaction (dated today by default), asserting 201, and return its id."""
        payload: dict[str, object] = {"occurredOn": occurred_on or _today_iso(), "name": "Movement"}
        payload.update(body)
        response = await client.post(TRANSACTIONS, json=payload)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        return response.json()["data"]["id"]

    async def test_posted_recurring_this_month_is_paid(self, test_client: httpx.AsyncClient):
        """
        GIVEN a recurring subscription POSTED this month
        WHEN the committed split is read for the current month (ARS)
        THEN it is on the paid side and nothing is pending (ADR-179)
        """
        # GIVEN
        await self._post(
            test_client, kind="expense", amountNum="1000", name="Rent", recurring=True, recurringCadence="monthly"
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN
        assert data["paid"]["subscription"] == "1000.00"
        assert data["paid"]["total"] == "1000.00"
        assert data["pending"]["total"] == "0.00"
        assert data["unconverted"] == 0

    async def test_due_not_posted_recurring_is_pending(self, test_client: httpx.AsyncClient):
        """
        GIVEN a monthly subscription whose latest actual is the PRIOR month (not yet posted this month)
        WHEN the committed split is read for the current month
        THEN it is on the pending side, not the paid side (ADR-179)
        """
        # GIVEN — last actual in the prior month; the monthly cadence lands this month.
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="800",
            name="Gym",
            recurring=True,
            recurringCadence="monthly",
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN
        assert data["pending"]["subscription"] == "800.00"
        assert data["pending"]["total"] == "800.00"
        assert data["paid"]["total"] == "0.00"

    async def test_posted_this_month_flips_from_pending_to_paid(self, test_client: httpx.AsyncClient):
        """
        GIVEN a monthly subscription with a PRIOR-month actual AND a fresh occurrence THIS month
        WHEN the committed split is read for the current month
        THEN it is paid (the this-month row lands) and NOT also pending - the flip (ADR-176/179)
        """
        # GIVEN — a prior-month row and a this-month row for the same (name, category) stream.
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="800",
            name="Gym",
            category="Health",
            recurring=True,
            recurringCadence="monthly",
        )
        await self._post(
            test_client,
            kind="expense",
            amountNum="800",
            name="Gym",
            category="Health",
            recurring=True,
            recurringCadence="monthly",
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — paid holds the posted cuota; pending is empty (no double-count).
        assert data["paid"]["subscription"] == "800.00"
        assert data["pending"]["total"] == "0.00"

    async def test_installment_paid_and_monotributo_pending_ars(self, test_client: httpx.AsyncClient):
        """
        GIVEN a configured monotributo category and an instalment cuota POSTED this month
        WHEN the ARS committed split is read
        THEN the cuota is paid, and the monotributo tax cuota (not posted) is pending (ADR-177/179)
        """
        # GIVEN — configure category A / services, then post an instalment cuota this month.
        patched = await test_client.patch(
            SETTINGS, json={"monotributoCurrentCategory": "A", "monotributoActivityType": "services"}
        )
        assert patched.status_code == status.HTTP_200_OK, patched.text
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
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN
        assert data["paid"]["installment"] == "500.00"
        assert Decimal(data["pending"]["tax"]) > Decimal(0)

    async def test_installment_same_name_category_collapses_to_one_plan(self, test_client: httpx.AsyncClient):
        """
        GIVEN two instalment rows sharing the same (name, category) posted this month
        WHEN the committed split is read
        THEN they collapse to ONE plan keyed off the LATEST occurrence, paid once (ADR-179)
        """
        # GIVEN — two "Sofa"/"Home" instalment cuotas this month; the newer is latest.
        today = date.today()
        older = today.replace(day=1).isoformat()
        newer = today.replace(day=min(28, max(2, today.day))).isoformat()
        for occurred, index in ((older, 3), (newer, 4)):
            await self._post(
                test_client,
                occurred_on=occurred,
                kind="expense",
                amountNum="800",
                name="Sofa",
                category="Home",
                recurringCadence="installment",
                installmentsTotal=6,
                installmentsIndex=index,
            )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — one plan; the paid installment side sums this month's posted cuotas for the stream.
        assert Decimal(data["paid"]["installment"]) > Decimal(0)
        assert data["pending"]["installment"] == "0.00"

    async def test_installment_usd_without_snapshot_is_counted_unconverted(self, test_client: httpx.AsyncClient):
        """
        GIVEN an instalment plan WITHOUT a USD snapshot due this month (prior-month actual)
        WHEN the USD committed split is read
        THEN its cuota is excluded from the totals and surfaced in unconverted (ADR-152/168)
        """
        # GIVEN — an ARS-only instalment (2 remaining) whose latest actual is the prior month.
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="5000",
            name="ARS plan",
            category="Home",
            recurringCadence="installment",
            installmentsTotal=4,
            installmentsIndex=2,
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "USD"})).json()["data"]

        # THEN
        assert data["unconverted"] == 1
        assert data["paid"]["total"] == "0.00"
        assert data["pending"]["total"] == "0.00"

    async def test_monotributo_cuota_paid_is_actual_posted_not_scale(self, test_client: httpx.AsyncClient):
        """
        GIVEN a configured monotributo category and a Taxes-category expense posted this month
              whose amount DIFFERS from the monotributo scale cuota
        WHEN the ARS committed split is read
        THEN paid.tax is the ACTUAL posted amount (not the scale cuota) and pending.tax flips
             to zero - the paid figure is the real spend already in the Expenses total (ADR-179)
        """
        # GIVEN — configure category A / services, then post a Taxes expense at a distinctive
        # amount (5,000) chosen NOT to coincide with any scale cuota, so the assertion is unambiguous.
        patched = await test_client.patch(
            SETTINGS, json={"monotributoCurrentCategory": "A", "monotributoActivityType": "services"}
        )
        assert patched.status_code == status.HTTP_200_OK, patched.text
        await self._post(
            test_client,
            kind="expense",
            amountNum="5000",
            name="Bank tax",
            category="Taxes",
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — paid.tax equals the ACTUAL posted spend (5,000), NOT the ~42k scale cuota; pending flips to 0.
        assert data["paid"]["tax"] == "5000.00"
        assert data["pending"]["tax"] == "0.00"

    async def test_monotributo_cuota_pending_at_scale_when_no_tax_expense_posted(self, test_client: httpx.AsyncClient):
        """
        GIVEN a configured monotributo category and NO Taxes-category expense posted this month
        WHEN the ARS committed split is read
        THEN pending.tax is the monotributo SCALE cuota and paid.tax is zero (ADR-177/179)
        """
        # GIVEN — configure category A / services; post nothing in the Taxes category.
        patched = await test_client.patch(
            SETTINGS, json={"monotributoCurrentCategory": "A", "monotributoActivityType": "services"}
        )
        assert patched.status_code == status.HTTP_200_OK, patched.text

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — the scale cuota is the pending (expected-this-month) figure; nothing is paid.
        assert Decimal(data["pending"]["tax"]) > Decimal(0)
        assert data["paid"]["tax"] == "0.00"

    async def test_usd_excludes_snapshotless_and_counts_unconverted(self, test_client: httpx.AsyncClient):
        """
        GIVEN a recurring expense WITHOUT a USD snapshot posted this month
        WHEN the USD committed split is read
        THEN it is excluded from the totals and surfaced in unconverted (ADR-152/168)
        """
        # GIVEN — an ARS-only recurring expense (no usd snapshot) posted this month.
        await self._post(test_client, kind="expense", amountNum="5000", name="Local sub", recurringCadence="monthly")

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "USD"})).json()["data"]

        # THEN
        assert data["currency"] == "USD"
        assert data["unconverted"] == 1
        assert data["paid"]["total"] == "0.00"
        assert data["pending"]["total"] == "0.00"

    async def test_empty_month_is_all_zero(self, test_client: httpx.AsyncClient):
        """
        GIVEN a user with no committed streams
        WHEN the committed split is read
        THEN every paid/pending figure is 0.00 (ADR-179)
        """
        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN
        assert data["paid"]["total"] == "0.00"
        assert data["pending"]["total"] == "0.00"
        assert data["unconverted"] == 0

    async def test_cadence_only_subscription_recurring_bool_false_is_recognized(self, test_client: httpx.AsyncClient):
        """
        GIVEN a subscription recorded via recurring_cadence='monthly' with the recurring
              bool UNSET (recurring=false) - the production reality (ADR-199)
        WHEN the committed split is read for the current month
        THEN it is recognized and lands on the paid side (ADR-199)
        """
        # GIVEN — no ``recurring`` flag at all; recurrence lives on the cadence (ADR-174/199).
        await self._post(test_client, kind="expense", amountNum="1200", name="OpenAI", recurringCadence="monthly")

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — the cadence alone makes it a subscription; the this-month row is paid.
        assert data["paid"]["subscription"] == "1200.00"
        assert data["pending"]["total"] == "0.00"

    async def test_installment_paid_via_loose_fallback_on_renamed_untagged_charge(self, test_client: httpx.AsyncClient):
        """
        GIVEN an installment plan due this month (prior-month actual, expected ~68,750) and a
              this-month Shopping expense with a DIFFERENT merchant name, NO installment tag,
              and an amount within 15% of expected
        WHEN the committed split is read
        THEN the plan is PAID by the untagged charge, not left pending (ADR-198/199)
        """
        # GIVEN — the plan's latest actual is the prior month so its exact-name row is not
        # this month; its remaining tail reaches this month at ~68,750.
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="68750",
            name="TOMMY",
            category="Shopping",
            recurringCadence="installment",
            installmentsTotal=6,
            installmentsIndex=2,
        )
        # An untagged, renamed statement-style charge this month, same category, within 15%.
        await self._post(
            test_client, kind="expense", amountNum="70000", name="TOMMY HILFIGER UNICENTER", category="Shopping"
        )

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — the plan flips to paid via the loose fallback; nothing pending for it.
        assert data["paid"]["installment"] == "70000.00"
        assert data["pending"]["installment"] == "0.00"

    async def test_loose_fallback_greedy_one_charge_per_stream(self, test_client: httpx.AsyncClient):
        """
        GIVEN two same-category installment plans due this month and TWO this-month untagged
              Shopping charges, each within tolerance of a distinct plan
        WHEN the committed split is read
        THEN each plan is matched to a DISTINCT charge (no charge fulfils two plans, ADR-199)
        """
        # GIVEN — two plans (100,000 and 50,000) with prior-month actuals so they are pending.
        for name, amount, index in (("Plan Big", "100000", 2), ("Plan Small", "50000", 3)):
            await self._post(
                test_client,
                occurred_on=_prior_month_first_iso(),
                kind="expense",
                amountNum=amount,
                name=name,
                category="Shopping",
                recurringCadence="installment",
                installmentsTotal=6,
                installmentsIndex=index,
            )
        # Two untagged this-month Shopping charges near each plan's amount.
        await self._post(test_client, kind="expense", amountNum="98000", name="Store One", category="Shopping")
        await self._post(test_client, kind="expense", amountNum="52000", name="Store Two", category="Shopping")

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — both plans paid (98,000 + 52,000 = 150,000); none left pending.
        assert data["paid"]["installment"] == "150000.00"
        assert data["pending"]["installment"] == "0.00"

    async def test_loose_fallback_ignores_out_of_tolerance_and_other_category_charges(
        self, test_client: httpx.AsyncClient
    ):
        """
        GIVEN an installment plan due this month and only this-month charges that are either
              out of tolerance or in a different category
        WHEN the committed split is read
        THEN the plan is NOT falsely marked paid - it stays pending (ADR-199)
        """
        # GIVEN — a plan expecting ~68,750 (prior-month actual → pending this month).
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="68750",
            name="TOMMY",
            category="Shopping",
            recurringCadence="installment",
            installmentsTotal=6,
            installmentsIndex=2,
        )
        # A same-category but far-off charge, and an in-range charge in the WRONG category.
        await self._post(test_client, kind="expense", amountNum="20000", name="Cheap thing", category="Shopping")
        await self._post(test_client, kind="expense", amountNum="70000", name="Food thing", category="Food")

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — no false match; the plan is still pending at its expected cuota.
        assert data["paid"]["installment"] == "0.00"
        assert data["pending"]["installment"] == "68750.00"

    async def test_loose_fallback_matched_stream_is_not_also_pending(self, test_client: httpx.AsyncClient):
        """
        GIVEN a plan paid via the loose fallback
        WHEN the committed split is read
        THEN the plan contributes to paid and is NEVER also in pending - the no-double-count
             invariant holds (ADR-179/199)
        """
        # GIVEN — a pending plan (prior-month actual) and a matching untagged this-month charge.
        await self._post(
            test_client,
            occurred_on=_prior_month_first_iso(),
            kind="expense",
            amountNum="40000",
            name="Sofa plan",
            category="Shopping",
            recurringCadence="installment",
            installmentsTotal=6,
            installmentsIndex=2,
        )
        await self._post(test_client, kind="expense", amountNum="41000", name="Muebles SA", category="Shopping")

        # WHEN
        data = (await test_client.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})).json()["data"]

        # THEN — paid holds the matched charge; pending is empty (no double-count).
        assert data["paid"]["installment"] == "41000.00"
        assert data["pending"]["installment"] == "0.00"

    async def test_user_b_committed_excludes_user_a(
        self,
        container: ApplicationContainer,
        test_client: httpx.AsyncClient,
        client_for_user,
    ):
        """
        GIVEN user A has a committed subscription this month
        WHEN user B reads the committed split
        THEN B's split is empty - A's commitments never leak (ADR-108, ADR-131)
        """
        # GIVEN — user A creates a recurring expense.
        await self._post(
            test_client, kind="expense", amountNum="900", name="A rent", recurring=True, recurringCadence="monthly"
        )

        # WHEN / THEN — user B sees none of A's commitments.
        async with client_for_user(container, STUB_AUTH_USER_B) as client_b:
            response = await client_b.get(COMMITTED, params={"month": _this_month_key(), "currency": "ARS"})
            assert response.status_code == status.HTTP_200_OK
            data = response.json()["data"]
            assert data["paid"]["total"] == "0.00"
            assert data["pending"]["total"] == "0.00"
