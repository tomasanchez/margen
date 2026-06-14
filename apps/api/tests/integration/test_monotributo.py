"""Integration tests for the Monotributo read-side against real PostgreSQL.

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove what the mocked fast tiers cannot: the server-side trailing-12-month
SUM with the kind + ``counts_toward_monotributo`` filter, the included-invoice
drilldown with its running cumulative, the read-records UPSERT + first-read
backfill of the snapshot history, the prior-window comparison resolving from a
persisted snapshot, and the config write the PATCH path relies on (ADR-046,
ADR-048, ADR-052).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.models.monotributo_snapshot import MonotributoSnapshotRecord
from margen_api.adapters.queries import SqlAlchemyMonotributoReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.domain.models.monotributo_scale import get_ceiling
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.monotributo import prior_window
from margen_api.service_layer.monotributo_handlers import capture_monotributo_snapshot

pytestmark = pytest.mark.integration

# A fixed server "today". Current window is [2025-06-01, 2026-06-14]; the prior
# window ends at 2025-06-01 (the period_end the comparison + backfill line up on).
REFERENCE = date(2026, 6, 14)
_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


def _counted(occurred_on: date, amount: str, *, kind: Kind = Kind.INVOICE, name: str = "Invoice"):
    """Build an invoice/income aggregate that counts toward the Monotributo limit."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=kind,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Consulting",
        counts_toward_monotributo=True,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _not_counted(occurred_on: date, amount: str):
    """Build an invoice flagged as NOT counting toward the limit (must be excluded)."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Non-counting invoice",
        kind=Kind.INVOICE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Consulting",
        counts_toward_monotributo=False,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


def _expense(occurred_on: date, amount: str):
    """Build an expense (must be excluded from the Monotributo total by kind)."""
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name="Spend",
        kind=Kind.EXPENSE,
        amount=Decimal(amount),
        currency=Currency.ARS,
        category="Food",
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )


async def _seed(session_factory: async_sessionmaker[AsyncSession], rows: list) -> None:
    """Persist the given aggregates through the transaction repository."""
    async with session_factory() as session:
        repository = SqlAlchemyTransactionRepository(session)
        for row in rows:
            repository.add(row)
        await session.commit()


class TestMonotributoAggregation:
    """The reader sums the trailing window with the kind + counting filter."""

    async def test_used_filters_kind_counts_and_window_with_drilldown(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN counting invoices/income, a non-counting invoice, an expense and an
              older out-of-window invoice
        WHEN the current trailing-12-month standing + drilldown are read from PostgreSQL
        THEN ``used`` sums only the counting income inside the window, and the
             drilldown lists exactly those rows oldest-first with a running cumulative
        """
        # GIVEN — only the three counting, in-window rows should total 1_700_000.
        await _seed(
            session_factory,
            [
                _counted(date(2026, 1, 15), "1000000.00"),  # in window, counts
                _counted(date(2026, 2, 1), "200000.00", kind=Kind.INCOME, name="Income"),  # income counts
                _counted(date(2026, 3, 10), "500000.00"),  # in window, counts
                _not_counted(date(2026, 4, 1), "999999.00"),  # excluded: flag
                _expense(date(2026, 2, 15), "300000.00"),  # excluded: kind
                _counted(date(2025, 1, 15), "700000.00"),  # excluded: before 2025-06-01
            ],
        )

        # WHEN
        async with session_factory() as session:
            reader = SqlAlchemyMonotributoReader(session)
            standing = await reader.current_standing(REFERENCE)
            snapshot = await reader.snapshot(REFERENCE)

        # THEN — used excludes the non-counting invoice, the expense and the old row.
        assert standing.used == Decimal("1700000.00")
        # No app_settings row under create_all → the settings default category 'C' (ADR-054/055).
        assert standing.category == "C"
        assert standing.limit == get_ceiling("C")
        assert standing.remaining == get_ceiling("C") - Decimal("1700000.00")

        # THEN — drilldown is the counting rows oldest-first with a running cumulative.
        amounts = [(invoice.amount, invoice.cumulative) for invoice in snapshot.invoices]
        assert amounts == [
            (Decimal("1000000.00"), Decimal("1000000.00")),
            (Decimal("200000.00"), Decimal("1200000.00")),
            (Decimal("500000.00"), Decimal("1700000.00")),
        ]


class TestReadRecordsAndBackfill:
    """Capture UPSERTs the current period and backfills history idempotently."""

    async def test_capture_backfills_and_previous_resolves_from_snapshot(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN counting income in both the current and the prior trailing windows
        WHEN the capture command runs against PostgreSQL, then runs a second time
        THEN the current period + the prior period_end get snapshot rows, a re-run
             does not duplicate the current row, and the reader's ``previous`` is the
             persisted prior-window snapshot
        """
        # GIVEN — prior-window income (lands in [2024-06-01, 2025-06-01]) + current.
        await _seed(
            session_factory,
            [
                _counted(date(2024, 12, 1), "800000.00", name="Prior invoice"),
                _counted(date(2026, 1, 15), "1000000.00"),
            ],
        )
        uow = SqlAlchemyUnitOfWork(session_factory)

        # WHEN — first capture (read-records current + first-read backfill).
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=REFERENCE), uow)

        prior_end = prior_window(REFERENCE)[1]
        async with session_factory() as session:
            total_after_first = await session.scalar(select(func.count()).select_from(MonotributoSnapshotRecord)) or 0
            current_rows = (
                await session.scalar(
                    select(func.count())
                    .select_from(MonotributoSnapshotRecord)
                    .where(MonotributoSnapshotRecord.period_end == date(2026, 6, 1))
                )
                or 0
            )
            prior_row = (
                await session.execute(
                    select(MonotributoSnapshotRecord).where(MonotributoSnapshotRecord.period_end == prior_end)
                )
            ).scalar_one_or_none()

        # THEN — backfill created the current month + 12 trailing months, incl. prior_end.
        assert total_after_first >= 13
        assert current_rows == 1
        assert prior_row is not None
        assert prior_row.used == Decimal("800000.00")

        # WHEN — a second capture (idempotent UPSERT keyed by period_end).
        await capture_monotributo_snapshot(CaptureMonotributoSnapshot(as_of=REFERENCE), uow)
        async with session_factory() as session:
            total_after_second = await session.scalar(select(func.count()).select_from(MonotributoSnapshotRecord)) or 0
            current_rows_again = (
                await session.scalar(
                    select(func.count())
                    .select_from(MonotributoSnapshotRecord)
                    .where(MonotributoSnapshotRecord.period_end == date(2026, 6, 1))
                )
                or 0
            )

        # THEN — no duplication; the current period_end still has exactly one row.
        assert total_after_second == total_after_first
        assert current_rows_again == 1

        # THEN — the reader resolves previous from the persisted prior-window snapshot.
        async with session_factory() as session:
            snapshot = await SqlAlchemyMonotributoReader(session).snapshot(REFERENCE)
        assert snapshot.previous is not None
        assert snapshot.previous.used == Decimal("800000.00")
        assert snapshot.previous.projection_note == "Saved snapshot from this period."


class TestConfigRoundTrip:
    """The settings category persists where the Monotributo reader then applies it (ADR-054)."""

    async def test_settings_category_is_read_back_and_used_by_the_reader(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a configured category D written through the settings repository
        WHEN it is read back and the reader computes the current standing
        THEN the persisted category round-trips and the standing uses category D's ceiling
        """
        # GIVEN
        async with session_factory() as session:
            repository = SqlAlchemySettingsRepository(session)
            await repository.upsert_settings(
                monotributo_current_category="D",
                monotributo_activity_type="services",
            )
            await session.commit()

        # WHEN
        async with session_factory() as session:
            persisted = await SqlAlchemySettingsRepository(session).get_settings()
        async with session_factory() as session:
            standing = await SqlAlchemyMonotributoReader(session).current_standing(REFERENCE)

        # THEN
        assert persisted.monotributo_current_category == "D"
        assert persisted.monotributo_activity_type == "services"
        assert standing.category == "D"
        assert standing.limit == get_ceiling("D")
