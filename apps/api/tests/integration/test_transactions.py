"""Integration tests for the transaction adapters against real PostgreSQL.

Marked ``integration`` (ADR-032): these run only when ``TEST_DATABASE_URL`` is
set and a real PostgreSQL is reachable, and are excluded from the coverage gate.
They prove the SQLAlchemy mappings, NUMERIC/Decimal precision and the nullable FX
block actually work end to end — what the mocked fast tiers cannot verify.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.queries import SqlAlchemyTransactionReader
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.domain.models.transaction import Transaction, build_transaction
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind, TxType

pytestmark = pytest.mark.integration

# The owning user threaded through every write/read (ADR-108). Contains hex letters
# so the ``UUID`` ownership column stays TEXT even on a digit-only-averse backend.
A_USER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


def _ars(occurred_on: date, name: str = "Apartment rent") -> Transaction:
    """Build an ARS aggregate with stable identity and timestamps."""
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.EXPENSE,
        amount=Decimal("123456.78"),
        currency=Currency.ARS,
        category="Rent",
        payment_method="Transfer",
        notes="monthly rent",
        user_id=A_USER,
        created_at=moment,
        updated_at=moment,
    )


def _usd(occurred_on: date, name: str = "MacBook") -> Transaction:
    """Build a complete USD aggregate carrying the full FX block."""
    moment = datetime(2026, 1, 2, tzinfo=UTC)
    return build_transaction(
        transaction_id=uuid4(),
        occurred_on=occurred_on,
        name=name,
        kind=Kind.INVOICE,
        amount=Decimal("1000500.50"),
        currency=Currency.USD,
        usd_amount=Decimal("1000.00"),
        fx_rate=Decimal("1000.500000"),
        fx_rate_type=FxRateType.MEP,
        fx_rate_as_of=datetime(2026, 1, 2, 12, 0, tzinfo=UTC),
        counts_toward_monotributo=True,
        user_id=A_USER,
        created_at=moment,
        updated_at=moment,
    )


class TestTransactionPersistenceRoundTrip:
    """A full CRUD round-trip across the repository and reader on PostgreSQL."""

    async def test_add_list_get_update_delete(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an ARS and a USD aggregate
        WHEN they are added, listed, fetched, updated and deleted via the adapters
        THEN PostgreSQL persists them newest-first with NUMERIC precision and FX,
             reflects the update, and removes them on hard delete
        """
        ars = _ars(date(2026, 6, 1))
        usd = _usd(date(2026, 6, 20))

        # WHEN — add both rows in one transaction.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            repository.add(ars)
            repository.add(usd)
            await session.commit()

        # THEN — the reader lists them newest-first (USD's later date wins).
        async with session_factory() as session:
            reader = SqlAlchemyTransactionReader(session)
            listed = await reader.list_transactions(A_USER)
            assert [model.id for model in listed] == [usd.id, ars.id]  # type: ignore[attr-defined]

            # FX block and NUMERIC precision survive the round-trip.
            usd_model = listed[0]
            assert usd_model.currency is Currency.USD
            assert usd_model.type is TxType.INCOME
            assert usd_model.amount == Decimal("1000500.50")
            assert usd_model.usd_amount == Decimal("1000.00")
            assert usd_model.fx_rate == Decimal("1000.500000")
            assert usd_model.fx_rate_type is FxRateType.MEP
            assert usd_model.counts_toward_monotributo is True

            # ARS row carries name/notes and no FX.
            ars_model = listed[1]
            assert ars_model.name == "Apartment rent"
            assert ars_model.notes == "monthly rent"
            assert ars_model.usd_amount is None
            assert ars_model.fx_rate is None

            # get by identity returns the same row.
            fetched = await reader.get_transaction(ars.id, A_USER)  # type: ignore[attr-defined]
            assert fetched is not None
            assert fetched.amount == Decimal("123456.78")

        # WHEN — load, mutate and persist the ARS aggregate.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            loaded = await repository.get(ars.id, A_USER)  # type: ignore[attr-defined]
            assert loaded is not None
            patched = build_transaction(
                transaction_id=loaded.id,
                occurred_on=loaded.occurred_on,
                name="Apartment rent (updated)",
                kind=loaded.kind,
                amount=Decimal("200000.00"),
                currency=loaded.currency,
                user_id=loaded.user_id,
                created_at=loaded.created_at,
                updated_at=datetime.now(UTC),
            )
            await repository.persist(patched)
            await session.commit()

        # THEN — the update is reflected.
        async with session_factory() as session:
            reader = SqlAlchemyTransactionReader(session)
            refreshed = await reader.get_transaction(ars.id, A_USER)  # type: ignore[attr-defined]
            assert refreshed is not None
            assert refreshed.name == "Apartment rent (updated)"
            assert refreshed.amount == Decimal("200000.00")

        # WHEN — hard-delete both rows.
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            assert await repository.delete(ars.id, A_USER) is True  # type: ignore[attr-defined]
            assert await repository.delete(usd.id, A_USER) is True  # type: ignore[attr-defined]
            await session.commit()

        # THEN — they are gone, and deleting again reports nothing removed.
        async with session_factory() as session:
            reader = SqlAlchemyTransactionReader(session)
            assert await reader.list_transactions(A_USER) == []
            repository = SqlAlchemyTransactionRepository(session)
            assert await repository.delete(ars.id, A_USER) is False  # type: ignore[attr-defined]


class TestMigrationParity:
    """The mapped model matches what the reader/repository expect on PostgreSQL."""

    async def test_persist_inserts_when_row_absent(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN an aggregate that was never added
        WHEN persist is called for it
        THEN the repository inserts it so the caller's change is not lost
        """
        ghost = _ars(date(2026, 7, 1), name="Ghost insert")

        # WHEN
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            await repository.persist(ghost)
            await session.commit()

        # THEN
        async with session_factory() as session:
            reader = SqlAlchemyTransactionReader(session)
            fetched = await reader.get_transaction(ghost.id, A_USER)  # type: ignore[attr-defined]
            assert fetched is not None
            assert fetched.name == "Ghost insert"
