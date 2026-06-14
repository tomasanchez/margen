"""Integration tests for the invoice document store against real PostgreSQL.

Marked ``integration`` (ADR-032/074): these run only when ``TEST_DATABASE_URL``
is set and a real PostgreSQL is reachable, and are excluded from the coverage
gate. They prove what the mocked fast tiers cannot: a stored invoice document
round-trips its bytes + extracted text + QR ``JSONB`` + the natural-key metadata
through real columns (``BYTEA``/``JSONB``/``NUMERIC``), and the advisory
dedupe lookup ``exists_by_natural_key`` matches the same key but not a different
one (ADR-071). A transaction is seeded first through the real repository so the
1:1 ``invoice_document.transaction_id`` foreign key is satisfied.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.document_store import SqlAlchemyDocumentStore
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.domain.commands.transaction import CreateTransaction, TransactionDocumentPayload
from margen_api.domain.models.transaction import build_transaction
from margen_api.domain.models.value_objects import Currency, Kind
from margen_api.service_layer.handlers import create_transaction

pytestmark = pytest.mark.integration

_MOMENT = datetime(2026, 1, 1, tzinfo=UTC)


async def _seed_transaction(session_factory: async_sessionmaker[AsyncSession]) -> UUID:
    """Persist one transaction through the real repository and return its id.

    The ``invoice_document.transaction_id`` FK (``ON DELETE CASCADE``, UNIQUE)
    requires a real parent row before a document can be stored.
    """
    transaction = build_transaction(
        transaction_id=uuid4(),
        occurred_on=date(2026, 6, 12),
        name="Acme SRL",
        kind=Kind.INVOICE,
        amount=Decimal("150000.50"),
        currency=Currency.ARS,
        category="Services",
        counts_toward_monotributo=True,
        created_at=_MOMENT,
        updated_at=_MOMENT,
    )
    async with session_factory() as session:
        SqlAlchemyTransactionRepository(session).add(transaction)
        await session.commit()
    return transaction.id


async def _save_document(
    session_factory: async_sessionmaker[AsyncSession],
    transaction_id: UUID,
    *,
    pdf_bytes: bytes,
    emisor_cuit: str | None = "20304050607",
    pto_vta: str | None = "5",
    tipo_cmp: str | None = "11",
    nro_cmp: str | None = "1234",
) -> None:
    """Store one invoice document for a transaction through the real store."""
    async with session_factory() as session:
        store = SqlAlchemyDocumentStore(session)
        await store.save(
            transaction_id=transaction_id,
            pdf_bytes=pdf_bytes,
            content_type="application/pdf",
            byte_size=len(pdf_bytes),
            extracted_text="Apellido y Nombre / Razón Social: Acme SRL",
            qr_json={"importe": "150000.50", "moneda": "PES"},
            emisor_cuit=emisor_cuit,
            pto_vta=pto_vta,
            tipo_cmp=tipo_cmp,
            nro_cmp=nro_cmp,
            cae="70123456789012",
            fecha=date(2026, 6, 12),
            importe=Decimal("150000.50"),
            moneda="ARS",
            ctz=Decimal("1.000000"),
        )
        await session.commit()


class TestDocumentRoundTrip:
    """A saved document reads back its bytes and import metadata intact."""

    async def test_save_then_get_round_trips_bytes_and_metadata(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a seeded transaction and a stored invoice document
        WHEN the document is read back through the store
        THEN the bytes, extracted text, QR JSON and the typed metadata round-trip
        """
        # GIVEN
        pdf_bytes = b"%PDF-1.4 real invoice body \x00\x01\x02 binary"
        transaction_id = await _seed_transaction(session_factory)
        await _save_document(session_factory, transaction_id, pdf_bytes=pdf_bytes)

        # WHEN
        async with session_factory() as session:
            document = await SqlAlchemyDocumentStore(session).get(transaction_id)

        # THEN
        assert document is not None
        assert document.transaction_id == transaction_id
        assert document.pdf_bytes == pdf_bytes
        assert document.content_type == "application/pdf"
        assert document.byte_size == len(pdf_bytes)
        assert document.extracted_text == "Apellido y Nombre / Razón Social: Acme SRL"
        assert document.qr_json == {"importe": "150000.50", "moneda": "PES"}
        assert document.emisor_cuit == "20304050607"
        assert document.pto_vta == "5"
        assert document.tipo_cmp == "11"
        assert document.nro_cmp == "1234"
        assert document.cae == "70123456789012"
        assert document.fecha == date(2026, 6, 12)
        assert document.importe == Decimal("150000.50")
        assert document.moneda == "ARS"
        assert document.ctz == Decimal("1.000000")

    async def test_get_returns_none_when_absent(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN no stored document for a transaction id
        WHEN the store is queried
        THEN it returns None
        """
        # WHEN
        async with session_factory() as session:
            document = await SqlAlchemyDocumentStore(session).get(uuid4())

        # THEN
        assert document is None


class TestCreateWithAttachment:
    """The create handler persists the transaction AND its document in one UoW.

    Guards the foreign-key ordering: the document insert must follow the
    transaction insert. The mocked fast tiers can't catch this (no real FK), and
    the other integration tests seed the two rows in separate commits — so this is
    the only check that exercises create_transaction's single-UoW attachment path
    against a real foreign key (regression for the IntegrityConflict, ADR-070/071).
    """

    async def test_create_persists_transaction_and_linked_document(
        self, session_factory: async_sessionmaker[AsyncSession]
    ):
        """
        GIVEN a create command carrying an invoice document
        WHEN the real handler runs against PostgreSQL in one unit of work
        THEN both the transaction and the linked document persist (no FK conflict)
        """
        # GIVEN
        pdf_bytes = b"%PDF-1.4 attached invoice"
        document = TransactionDocumentPayload(
            pdf_bytes=pdf_bytes,
            content_type="application/pdf",
            byte_size=len(pdf_bytes),
            extracted_text="Beta SRL",
            qr_json={"ver": 1},
            emisor_cuit="20111111110",
            pto_vta="3",
            tipo_cmp="11",
            nro_cmp="42",
            cae="70000000000009",
            fecha=date(2026, 6, 12),
            importe=Decimal("1000.00"),
            moneda="ARS",
            ctz=Decimal("1"),
        )
        command = CreateTransaction(
            occurred_on=date(2026, 6, 12),
            name="Beta SRL",
            kind=Kind.INVOICE,
            amount=Decimal("1000.00"),
            currency=Currency.ARS,
            counts_toward_monotributo=True,
            document=document,
        )

        # WHEN — the handler flushes the transaction, then attaches the document.
        transaction_id = await create_transaction(command, SqlAlchemyUnitOfWork(session_factory))

        # THEN — both rows persisted and the document links to the transaction.
        async with session_factory() as session:
            transaction = await SqlAlchemyTransactionRepository(session).get(transaction_id)
            stored = await SqlAlchemyDocumentStore(session).get(transaction_id)
        assert transaction is not None
        assert stored is not None
        assert stored.transaction_id == transaction_id
        assert stored.pdf_bytes == pdf_bytes


class TestExistsByNaturalKey:
    """The advisory dedupe lookup matches the stored natural key only."""

    async def test_matches_same_key_and_not_a_different_one(self, session_factory: async_sessionmaker[AsyncSession]):
        """
        GIVEN a stored document with a known natural key
        WHEN exists_by_natural_key is queried with the same key, then a different one
        THEN it returns True for the same key and False for a different one
        """
        # GIVEN
        transaction_id = await _seed_transaction(session_factory)
        await _save_document(session_factory, transaction_id, pdf_bytes=b"%PDF-dedupe")

        # WHEN / THEN — the exact key matches.
        async with session_factory() as session:
            store = SqlAlchemyDocumentStore(session)
            same = await store.exists_by_natural_key(
                emisor_cuit="20304050607",
                pto_vta="5",
                tipo_cmp="11",
                nro_cmp="1234",
            )
            # WHEN / THEN — a different voucher number does not match.
            different = await store.exists_by_natural_key(
                emisor_cuit="20304050607",
                pto_vta="5",
                tipo_cmp="11",
                nro_cmp="9999",
            )

        assert same is True
        assert different is False
