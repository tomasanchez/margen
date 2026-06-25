"""Integration tests for the statement document store against real PostgreSQL.

Marked ``integration`` (ADR-032/082): they run only when ``TEST_DATABASE_URL``
is set and a real PostgreSQL is reachable, and are excluded from the coverage
gate. They prove what the mocked fast tiers cannot: a stored statement document
round-trips its bytes + extracted text + statement metadata through real columns
(``BYTEA``/``NUMERIC``), the advisory dedupe lookup matches the same natural key
but not a different one (ADR-077), and the import handler persists one statement
document plus its N linked EXPENSE transactions atomically against a real foreign
key (ADR-078) — each ``transactions.statement_document_id`` resolving to the
shared parent row.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.statement_store import SqlAlchemyStatementStore
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.statement import (
    ImportStatement,
    StatementDocumentPayload,
    StatementLineInput,
    StatementLineResolution,
)
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.handlers import import_statement

pytestmark = pytest.mark.integration

# The owning user threaded through the import/read path (ADR-108).
A_USER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


async def _save_document(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    pdf_bytes: bytes,
    issuer_cuit: str | None = "30-50000173-5",
    card_last4: str | None = "5771",
    statement_number: str | None = "VI00000000069436867",
):
    """Store one statement document through the real store and return its id."""
    async with session_factory() as session:
        store = SqlAlchemyStatementStore(session)
        document_id = await store.save(
            user_id=A_USER,
            pdf_bytes=pdf_bytes,
            content_type="application/pdf",
            byte_size=len(pdf_bytes),
            extracted_text="JUAN PEREZ Galicia VISA statement",
            bank_name="Galicia",
            network="VISA",
            card_last4=card_last4,
            issuer_cuit=issuer_cuit,
            statement_number=statement_number,
            period_close=date(2026, 6, 11),
            period_due=date(2026, 6, 19),
            total_amount=Decimal("14521.66"),
        )
        await session.commit()
    return document_id


class TestStatementDocumentRoundTrip:
    """A saved statement document reads back its bytes and metadata intact."""

    async def test_save_then_get_round_trips_bytes_and_metadata(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a stored statement document
        WHEN it is read back through the store by its id
        THEN the bytes and the typed statement metadata round-trip
        """
        # GIVEN
        pdf_bytes = b"%PDF-1.4 real statement body \x00\x01\x02 binary"
        document_id = await _save_document(session_factory, pdf_bytes=pdf_bytes)

        # WHEN
        async with session_factory() as session:
            document = await SqlAlchemyStatementStore(session).get(document_id, A_USER)

        # THEN
        assert document is not None
        assert document.id == document_id
        assert document.pdf_bytes == pdf_bytes
        assert document.content_type == "application/pdf"
        assert document.byte_size == len(pdf_bytes)
        assert document.bank_name == "Galicia"
        assert document.network == "VISA"
        assert document.card_last4 == "5771"
        assert document.issuer_cuit == "30-50000173-5"
        assert document.statement_number == "VI00000000069436867"
        assert document.period_close == date(2026, 6, 11)
        assert document.period_due == date(2026, 6, 19)
        assert document.total_amount == Decimal("14521.66")

    async def test_get_returns_none_when_absent(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN no stored statement document for an id
        WHEN the store is queried
        THEN it returns None
        """
        # WHEN
        async with session_factory() as session:
            document = await SqlAlchemyStatementStore(session).get(uuid4(), A_USER)

        # THEN
        assert document is None


class TestExistsByNaturalKey:
    """The advisory dedupe lookup matches the stored statement natural key only."""

    async def test_matches_same_key_and_not_a_different_one(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a stored statement document with a known natural key
        WHEN exists_by_natural_key is queried with the same key, then a different one
        THEN it returns True for the same key and False for a different statement
        """
        # GIVEN
        await _save_document(session_factory, pdf_bytes=b"%PDF-dedupe")

        # WHEN / THEN
        async with session_factory() as session:
            store = SqlAlchemyStatementStore(session)
            same = await store.exists_by_natural_key(
                issuer_cuit="30-50000173-5",
                card_last4="5771",
                statement_number="VI00000000069436867",
            )
            different = await store.exists_by_natural_key(
                issuer_cuit="30-50000173-5",
                card_last4="5771",
                statement_number="VI99999999999999999",
            )

        assert same is True
        assert different is False


class TestImportStatementAtomic:
    """The import handler persists the document AND its N transactions in one UoW.

    Guards the foreign-key path against a real database: every created
    ``transactions.statement_document_id`` must resolve to the saved parent row
    (regression for the dashed/no-dash UUID id mismatch, ADR-077/078). The mocked
    fast tiers run on SQLite with FK enforcement off, so this is the only check
    that exercises the batch import against a real foreign key.
    """

    async def test_import_persists_document_and_linked_transactions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN an import command with a document and two confirmed lines
        WHEN the real handler runs against PostgreSQL in one unit of work
        THEN the document and both linked EXPENSE transactions persist
        """
        # GIVEN
        pdf_bytes = b"%PDF-1.4 attached statement"
        document = StatementDocumentPayload(
            pdf_bytes=pdf_bytes,
            content_type="application/pdf",
            byte_size=len(pdf_bytes),
            extracted_text="JUAN PEREZ",
            bank_name="Galicia",
            network="VISA",
            card_last4="5771",
            issuer_cuit="30-50000173-5",
            statement_number="VI00000000069436867",
            period_close=date(2026, 6, 11),
            period_due=date(2026, 6, 19),
            total_amount=Decimal("13821.66"),
        )
        command = ImportStatement(
            user_id=A_USER,
            document=document,
            lines=[
                StatementLineInput(
                    occurred_on=date(2026, 3, 20),
                    name="MERPAGO*PASSLINE",
                    amount=Decimal("3641.66"),
                    currency=Currency.ARS,
                    category="Entertainment",
                    payment_method="Galicia VISA ·5771",
                    notes="Cuota 03/03",
                ),
                StatementLineInput(
                    occurred_on=date(2026, 5, 8),
                    name="Express Av Cordoba 3721",
                    amount=Decimal("10180.00"),
                    currency=Currency.ARS,
                    category="Food",
                    payment_method="Galicia VISA ·5771",
                ),
            ],
        )

        # WHEN
        result = await import_statement(command, SqlAlchemyUnitOfWork(session_factory))

        # THEN — the document and both transactions persisted and link back.
        assert len(result.created_transaction_ids) == 2
        async with session_factory() as session:
            stored = await SqlAlchemyStatementStore(session).get(result.statement_document_id, A_USER)
            repository = SqlAlchemyTransactionRepository(session)
            transactions = [
                await repository.get(transaction_id, A_USER) for transaction_id in result.created_transaction_ids
            ]

        assert stored is not None
        assert stored.pdf_bytes == pdf_bytes
        loaded = [transaction for transaction in transactions if transaction is not None]
        assert len(loaded) == 2
        assert all(transaction.statement_document_id == result.statement_document_id for transaction in loaded)
        assert {transaction.name for transaction in loaded} == {
            "MERPAGO*PASSLINE",
            "Express Av Cordoba 3721",
        }


class TestImportStatementMerge:
    """A merge line enriches an existing manual expense in place against real PostgreSQL.

    Guards the per-line reconciliation merge path (ADR-085) against a real database:
    the existing row keeps its identity, gains the statement document link and card,
    fills an empty category, and NO duplicate row is created.
    """

    async def test_merge_enriches_existing_manual_expense_without_duplicating(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a manual EXPENSE persisted through the real repository (no card, no category)
        WHEN import_statement runs a merge line targeting it over the real unit of work
        THEN the existing row is enriched in place (statement document linked, card set,
             category filled) and no duplicate row exists
        """
        # GIVEN — a manual expense with an empty category and no payment method.
        now = datetime(2026, 5, 8, tzinfo=UTC)
        manual = build_transaction(
            transaction_id=uuid4(),
            created_at=now,
            updated_at=now,
            occurred_on=date(2026, 5, 8),
            name="Express Cordoba dinner",
            kind=Kind.EXPENSE,
            amount=Decimal("10180.00"),
            currency=Currency.ARS,
            user_id=A_USER,
        )
        async with session_factory() as session:
            repository = SqlAlchemyTransactionRepository(session)
            repository.add(manual)
            await session.commit()

        pdf_bytes = b"%PDF-1.4 merge statement"
        command = ImportStatement(
            user_id=A_USER,
            document=StatementDocumentPayload(
                pdf_bytes=pdf_bytes,
                content_type="application/pdf",
                byte_size=len(pdf_bytes),
                bank_name="Galicia",
                network="VISA",
                card_last4="5771",
                issuer_cuit="30-50000173-5",
                statement_number="VI00000000069436867",
            ),
            lines=[
                StatementLineInput(
                    occurred_on=date(2026, 5, 8),
                    name="Express Av Cordoba 3721",
                    amount=Decimal("10180.00"),
                    currency=Currency.ARS,
                    category="Food",
                    payment_method="Galicia VISA ·5771",
                    resolution=StatementLineResolution.MERGE,
                    match_transaction_id=manual.id,
                ),
            ],
        )

        # WHEN
        result = await import_statement(command, SqlAlchemyUnitOfWork(session_factory))

        # THEN — one merge, no creation.
        assert result.merged_transaction_ids == [manual.id]
        assert result.created_transaction_ids == []

        # THEN — the existing row was enriched in place; no duplicate exists.
        async with session_factory() as session:
            enriched = await SqlAlchemyTransactionRepository(session).get(manual.id, A_USER)
            row_count = await session.scalar(select(func.count()).select_from(TransactionRecord))

        assert enriched is not None
        assert enriched.id == manual.id  # same identity, not a new row.
        assert enriched.statement_document_id == result.statement_document_id  # document linked.
        assert enriched.payment_method == "Galicia VISA ·5771"  # card set from the line.
        assert enriched.category == "Food"  # filled because it was empty.
        assert enriched.amount == Decimal("10180.00")  # user's manual amount preserved.

        # THEN — exactly one transaction row exists: the merge did not create a duplicate.
        assert row_count == 1
