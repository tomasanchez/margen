"""Integration tests for the forecast reader against real PostgreSQL (ADR-176, ADR-177).

Marked ``integration`` (ADR-032): these run only when a real PostgreSQL is reachable and
are excluded from the coverage gate. They prove the committed-stream SQL — the
``(name, category)`` collapse to each stream's LATEST occurrence, the recurring cadence /
instalment tail derivation, the USD snapshot denomination with the unconverted count,
the monotributo-cuota lookup wired through the settings repository, and owner scoping —
actually work end to end, which the mocked fast tiers cannot verify.

The reader anchors its horizon at ``datetime.now(UTC)`` (the month AFTER the current
month), so movements are placed in the current month to stay date-robust.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.forecast_queries import SqlAlchemyForecastReader
from margen_api.adapters.monotributo_repository import SqlAlchemyMonotributoSnapshotRepository
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.domain.models.monotributo_scale import get_category
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind, RecurringCadence
from margen_api.service_layer.summaries import add_months, month_key

pytestmark = pytest.mark.integration

# Two distinct owners prove the forecast is scoped to the caller (ADR-131).
OWNER = "33333333-3333-4333-8333-333333333333"
OTHER_OWNER = "44444444-4444-4444-8444-444444444444"

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _first_of_current_month() -> date:
    """Return the first day of the current calendar month."""
    today = datetime.now(UTC).date()
    return date(today.year, today.month, 1)


def _next_month_key() -> str:
    """Return the month AFTER the current month as ``YYYY-MM`` (the horizon start)."""
    return month_key(add_months(_first_of_current_month(), 1))


def _tx(**overrides: object):
    """Build an EXPENSE transaction with sensible defaults for the forecast streams."""
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


def _reader(session: AsyncSession) -> SqlAlchemyForecastReader:
    """Build the forecast reader wired to the monotributo repo over the same session."""
    return SqlAlchemyForecastReader(session, SqlAlchemyMonotributoSnapshotRepository(session))


class TestForecastSql:
    """The reader derives committed streams from real rows and projects them forward."""

    async def test_recurring_and_installment_streams_from_latest_occurrence(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN two occurrences of a monthly subscription (older + newer) and an instalment
              plan (cuota 2 of 4) this month
        WHEN the ARS forecast is read from PostgreSQL
        THEN the subscription collapses to one stream at its LATEST amount and the
             instalment tail runs for its remaining payments (ADR-176)
        """
        # GIVEN
        this_month = _first_of_current_month()
        older = this_month.replace(day=1)
        newer = this_month.replace(day=min(28, max(2, this_month.day)))
        rows = [
            _tx(
                name="Rent",
                category="Housing",
                amount=Decimal("100"),
                occurred_on=older,
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
            _tx(
                name="Rent",
                category="Housing",
                amount=Decimal("300"),
                occurred_on=newer,
                recurring=True,
                recurring_cadence=RecurringCadence.MONTHLY,
            ),
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
            series = await _reader(session).forecast(OWNER, horizon=6, currency=Currency.ARS)

        # THEN — one subscription (latest 300) + one instalment tail (remaining 2).
        by_source = {}
        for line in series.commitments:
            by_source.setdefault(line.source.value, []).append(line)
        assert len(by_source["subscription"]) == 1
        assert by_source["subscription"][0].amount == Decimal("300.00")
        assert len(by_source["installment"]) == 1
        assert by_source["installment"][0].remaining_count == 2
        assert len(by_source["installment"][0].months) == 2
        # Next month sums the subscription (300) + one instalment cuota (500) = 800.
        next_month = _next_month_key()
        totals = {m.month: m.committed for m in series.months}
        assert totals[next_month] == Decimal("800.00")
        assert series.unconverted == 0

    async def test_usd_snapshot_denomination_and_unconverted(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a recurring expense WITH a USD snapshot and one WITHOUT
        WHEN the USD forecast is read from PostgreSQL
        THEN the snapshotted stream projects on its usd_amount and the snapshotless one
             is excluded and counted in unconverted (ADR-152, ADR-168)
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
            series = await _reader(session).forecast(OWNER, horizon=2, currency=Currency.USD)

        # THEN
        assert series.currency == "USD"
        assert series.unconverted == 1
        assert [line.label for line in series.commitments] == ["Cloud"]
        assert all(month.committed == Decimal("20.00") for month in series.months)

    async def test_monotributo_cuota_from_configured_settings(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a configured monotributo category (services) in app_settings
        WHEN the ARS forecast is read from PostgreSQL
        THEN the configured category's services cuota lands in every horizon month (ADR-177)
        """
        # GIVEN — configure category B / services via the real settings repository.
        async with session_factory() as session:
            await SqlAlchemySettingsRepository(session).upsert_settings(
                OWNER, monotributo_current_category="B", monotributo_activity_type="services"
            )
            await session.commit()

        # WHEN
        async with session_factory() as session:
            series = await _reader(session).forecast(OWNER, horizon=2, currency=Currency.ARS)

        # THEN — the cuota is resolved per projected month's vintage (ADR-067). Derive the
        # expected figure the same way, as-of each horizon month, so the assertion stays
        # robust to the live clock and to any vintage boundary inside the 2-month horizon.
        first_month = add_months(_first_of_current_month(), 1)
        horizon_months = [first_month, add_months(first_month, 1)]
        expected_by_month = {month_key(m): get_category("B", as_of=m).cuota_servicios for m in horizon_months}
        tax_lines = [line for line in series.commitments if line.source.value == "tax"]
        # Every tax line's amount matches the vintage cuota for each month it lists.
        for line in tax_lines:
            for m in line.months:
                assert line.amount == expected_by_month[m]
        assert sorted(m for line in tax_lines for m in line.months) == sorted(expected_by_month)
        assert all(month.committed == expected_by_month[month.month] for month in series.months)

    async def test_forecast_is_owner_scoped(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN owner A has a recurring commitment
        WHEN owner B's forecast is read from PostgreSQL
        THEN B sees none of A's commitments (ADR-108, ADR-131)
        """
        # GIVEN
        await _seed(
            session_factory,
            [_tx(name="A only", category="X", recurring=True, recurring_cadence=RecurringCadence.MONTHLY)],
        )

        # WHEN
        async with session_factory() as session:
            series = await _reader(session).forecast(OTHER_OWNER, horizon=3, currency=Currency.ARS)

        # THEN
        assert series.commitments == []
        assert all(month.committed == Decimal("0.00") for month in series.months)
