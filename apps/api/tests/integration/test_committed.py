"""Integration tests for the committed-spend reader against real PostgreSQL (ADR-179).

Marked ``integration`` (ADR-032): these run only when a real PostgreSQL is reachable and
are excluded from the coverage gate. They prove the committed-split SQL - the
``(name, category)`` collapse to each stream's LATEST occurrence, the posted-this-month
detection, the pending (expected-this-month, offset 0) derivation, the paid/pending flip,
the USD snapshot denomination with the unconverted count, the monotributo cuota wired
through the settings repository, and owner scoping - actually work end to end, which the
mocked fast tiers cannot verify.

The reader evaluates the split for a TARGET month; movements are placed in the current /
a prior month so the paid/pending state is date-robust regardless of the run date.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.committed_queries import SqlAlchemyCommittedReader
from margen_api.adapters.monotributo_repository import SqlAlchemyMonotributoSnapshotRepository
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.summaries import add_months

pytestmark = pytest.mark.integration

# Two distinct owners prove the split is scoped to the caller (ADR-131).
OWNER = "55555555-5555-4555-8555-555555555555"
OTHER_OWNER = "66666666-6666-4666-8666-666666666666"

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _first_of_current_month() -> date:
    """Return the first day of the current calendar month."""
    today = datetime.now(UTC).date()
    return date(today.year, today.month, 1)


def _first_of_prior_month() -> date:
    """Return the first day of the PRIOR calendar month."""
    return add_months(_first_of_current_month(), -1)


def _tx(**overrides: object):
    """Build an EXPENSE transaction with sensible defaults for the committed streams."""
    defaults: dict[str, object] = {
        "transaction_id": uuid4(),
        "occurred_on": _first_of_current_month(),
        "name": "Movement",
        "kind": Kind.EXPENSE,
        "amount": Decimal("1000"),
        "user_id": OWNER,
        "created_at": _MOMENT,
        "updated_at": _MOMENT,
    }
    defaults.update(overrides)
    return build_transaction(**defaults)  # type: ignore[arg-type]


async def _seed(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist the given transaction aggregates in one committed session."""
    async with session_factory() as session:
        repo = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repo.add(row)
        await session.commit()


def _reader(session: AsyncSession) -> SqlAlchemyCommittedReader:
    """Build the committed reader wired to the monotributo repo over the same session."""
    return SqlAlchemyCommittedReader(session, SqlAlchemyMonotributoSnapshotRepository(session))


class TestCommittedSql:
    """The reader derives the paid/pending split from real rows for a target month."""

    async def test_posted_recurring_is_paid_and_prior_month_actual_is_pending(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN one recurring subscription POSTED this month and one whose latest actual is
              the PRIOR month (due this month, not yet posted)
        WHEN the ARS committed split is read for the current month
        THEN the posted one is paid and the prior-month one is pending (ADR-179)
        """
        # GIVEN
        rows = [
            _tx(
                name="Rent",
                category="Housing",
                amount=Decimal("1000"),
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
            _tx(
                name="Gym",
                category="Health",
                amount=Decimal("800"),
                occurred_on=_first_of_prior_month(),
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.subscription == Decimal("1000.00")
        assert split.pending.subscription == Decimal("800.00")
        assert split.unconverted == 0

    async def test_posted_this_month_flips_from_pending_to_paid(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a monthly subscription with a PRIOR-month actual AND a fresh occurrence THIS month
        WHEN the ARS committed split is read for the current month
        THEN it is paid (this-month row lands) and NOT also pending - the flip (ADR-176/179)
        """
        # GIVEN — the same (name, category) stream posted in both the prior and current month.
        rows = [
            _tx(
                name="Gym",
                category="Health",
                amount=Decimal("800"),
                occurred_on=_first_of_prior_month(),
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
            _tx(
                name="Gym",
                category="Health",
                amount=Decimal("800"),
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.subscription == Decimal("800.00")
        assert split.pending.subscription == Decimal("0.00")

    async def test_installment_posted_this_month_is_paid(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an instalment cuota POSTED this month (cuota 2 of 4)
        WHEN the ARS committed split is read for the current month
        THEN the cuota is on the paid installment side (ADR-179)
        """
        # GIVEN
        rows = [
            _tx(
                name="Fridge",
                category="Home",
                amount=Decimal("500"),
                recurring_cadence=RecurringCadence.INSTALLMENT,
                installments_total=4,
                installments_index=2,
            ),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.installment == Decimal("500.00")
        assert split.pending.installment == Decimal("0.00")

    async def test_usd_snapshot_denomination_and_unconverted(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a recurring expense WITH a USD snapshot posted this month and one WITHOUT
        WHEN the USD committed split is read
        THEN the snapshotted stream is paid on its usd_amount and the snapshotless one is
             excluded and counted in unconverted (ADR-152, ADR-168)
        """
        # GIVEN
        rows = [
            _tx(
                name="Cloud",
                category="Tech",
                amount=Decimal("20000"),
                currency=Currency.USD,
                usd_amount=Decimal("20"),
                fx_rate=Decimal("1000"),
                fx_source="mep",
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
            _tx(
                name="Local sub",
                category="Misc",
                amount=Decimal("5000"),
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.USD)

        # THEN
        assert split.currency == "USD"
        assert split.unconverted == 1
        assert split.paid.subscription == Decimal("20.00")

    async def test_monotributo_cuota_pending_when_not_posted(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a configured monotributo category (services) and no monotributo expense this month
        WHEN the ARS committed split is read
        THEN the configured category's services cuota is pending tax (ADR-177/179)
        """
        # GIVEN — configure category B / services via the real settings repository.
        async with session_factory() as session:
            await SqlAlchemySettingsRepository(session).upsert_settings(
                OWNER, monotributo_current_category="B", monotributo_activity_type="services"
            )
            await session.commit()

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        expected = get_category("B").cuota_servicios
        assert split.pending.tax == expected
        assert split.paid.tax == Decimal("0.00")

    async def test_monotributo_paid_tax_is_actual_posted_amount_not_scale(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a configured monotributo category and a Taxes-category expense posted this
              month at an amount DIFFERENT from the scale cuota
        WHEN the ARS committed split is read
        THEN paid.tax is the ACTUAL posted amount (not the scale cuota) and pending.tax is 0 (ADR-179)
        """
        # GIVEN — configure category B / services, then post a Taxes expense at a distinctive 5,000.
        async with session_factory() as session:
            await SqlAlchemySettingsRepository(session).upsert_settings(
                OWNER, monotributo_current_category="B", monotributo_activity_type="services"
            )
            await session.commit()
        await _seed(session_factory, [_tx(name="Bank tax", category="Taxes", amount=Decimal("5000"))])

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN — paid.tax is the real posted spend, NOT the scale cuota; pending flips to 0.
        assert split.paid.tax == Decimal("5000.00")
        assert split.paid.tax != get_category("B").cuota_servicios
        assert split.pending.tax == Decimal("0.00")

    async def test_cadence_only_subscription_recurring_bool_false_is_recognized(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a subscription recorded via recurring_cadence='monthly' with recurring=False
              (the production reality, ADR-199)
        WHEN the ARS committed split is read for the current month
        THEN it is recognized and paid (the cadence alone is the source signal, ADR-199)
        """
        # GIVEN — no recurring flag; recurrence lives on the cadence (ADR-174/199).
        await _seed(
            session_factory,
            [
                _tx(
                    name="OpenAI",
                    category="Subscriptions",
                    amount=Decimal("1200"),
                    recurring_cadence=RecurringCadence.MONTHLY,
                )
            ],
        )

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.subscription == Decimal("1200.00")
        assert split.pending.subscription == Decimal("0.00")

    async def test_installment_paid_via_loose_fallback_on_renamed_untagged_charge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN an installment plan due this month (prior-month actual, expected 68,750) and a
              this-month same-category untagged charge with a different name within 15%
        WHEN the ARS committed split is read
        THEN the plan is PAID by the untagged charge, not left pending (ADR-198/199)
        """
        # GIVEN — a plan whose latest actual is the prior month (so no exact this-month row)
        # and a renamed untagged Shopping charge this month within tolerance.
        rows = [
            _tx(
                name="TOMMY",
                category="Shopping",
                amount=Decimal("68750"),
                occurred_on=_first_of_prior_month(),
                recurring_cadence=RecurringCadence.INSTALLMENT,
                installments_total=6,
                installments_index=2,
            ),
            _tx(name="TOMMY HILFIGER UNICENTER", category="Shopping", amount=Decimal("70000")),
        ]
        await _seed(session_factory, rows)

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.installment == Decimal("70000.00")
        assert split.pending.installment == Decimal("0.00")

    async def test_committed_is_owner_scoped(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN owner A has a committed subscription this month
        WHEN owner B's committed split is read from PostgreSQL
        THEN B sees none of A's commitments (ADR-108, ADR-131)
        """
        # GIVEN
        await _seed(
            session_factory,
            [_tx(name="A only", category="X", recurring=True, recurring_cadence=RecurringCadence.MONTHLY)],
        )

        # WHEN
        async with session_factory() as session:
            split = await _reader(session).committed(_first_of_current_month(), OTHER_OWNER, currency=Currency.ARS)

        # THEN
        assert split.paid.total == Decimal("0.00")
        assert split.pending.total == Decimal("0.00")
