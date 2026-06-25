"""Unit tests for the SQLAlchemy invoice-document adapter (ADR-032, ADR-071).

Per ADR-032 these mock the ``AsyncSession`` and the execute result -- no real
database. They assert that ``save`` stages a record for the next commit, that
``get`` projects a stored row into the download read model (or returns ``None``
when absent), and that ``exists_by_natural_key`` reflects whether a matching row
exists (the advisory dedupe check).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

from margen_api.adapters.document_store import SqlAlchemyDocumentStore
from margen_api.adapters.models.invoice_document import InvoiceDocumentRecord

# A valid Supabase ``sub`` (UUID string); the adapter coerces it to ``UUID`` for
# the nullable ownership column (ADR-108).
_A_USER = "f0e1d2c3-b4a5-4960-8788-99aabbccddee"


def _session() -> AsyncMock:
    """Build a mocked AsyncSession with a synchronous ``add``."""
    session = AsyncMock()
    session.add = MagicMock()
    return session


def _scalar_result(value: object) -> MagicMock:
    """Wrap a value in a fake result exposing ``scalar_one_or_none``."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _first_result(value: object) -> MagicMock:
    """Wrap a value in a fake result exposing ``first``."""
    result = MagicMock()
    result.first.return_value = value
    return result


def _record() -> InvoiceDocumentRecord:
    """Build a persisted invoice_document row."""
    record = InvoiceDocumentRecord()
    record.transaction_id = uuid4()
    record.pdf_bytes = b"%PDF-1.4 body"
    record.content_type = "application/pdf"
    record.byte_size = 13
    record.extracted_text = "Acme SRL"
    record.qr_json = {"ver": 1}
    record.emisor_cuit = "20304050607"
    record.pto_vta = "5"
    record.tipo_cmp = "11"
    record.nro_cmp = "1234"
    record.cae = "70123456789012"
    record.fecha = date(2026, 6, 12)
    record.importe = Decimal("150000.50")
    record.moneda = "PES"
    record.ctz = Decimal("1")
    return record


class TestSave:
    """``save`` stages one document row on the session."""

    async def test_adds_record(self):
        """GIVEN document fields WHEN save THEN an owned InvoiceDocumentRecord is added."""
        # GIVEN
        session = _session()
        store = SqlAlchemyDocumentStore(session)
        transaction_id = uuid4()

        # WHEN
        await store.save(
            transaction_id=transaction_id,
            user_id=_A_USER,
            pdf_bytes=b"%PDF-1.4 body",
            content_type="application/pdf",
            byte_size=13,
            extracted_text="Acme SRL",
            qr_json={"ver": 1},
            emisor_cuit="20304050607",
            pto_vta="5",
            tipo_cmp="11",
            nro_cmp="1234",
            cae="70123456789012",
            fecha=date(2026, 6, 12),
            importe=Decimal("150000.50"),
            moneda="PES",
            ctz=Decimal("1"),
        )

        # THEN
        session.add.assert_called_once()
        (added,) = session.add.call_args.args
        assert isinstance(added, InvoiceDocumentRecord)
        assert added.transaction_id == transaction_id
        assert added.pdf_bytes == b"%PDF-1.4 body"
        # THEN — the string owner is coerced to a UUID for the ownership column (ADR-108).
        assert added.user_id == UUID(_A_USER)

    async def test_unowned_save_keeps_user_id_none(self):
        """GIVEN no owner WHEN save THEN the ownership column stays NULL (legacy rows)."""
        # GIVEN
        session = _session()
        store = SqlAlchemyDocumentStore(session)

        # WHEN
        await store.save(
            transaction_id=uuid4(),
            user_id=None,
            pdf_bytes=b"%PDF-1.4 body",
            content_type="application/pdf",
            byte_size=13,
            extracted_text=None,
            qr_json=None,
            emisor_cuit=None,
            pto_vta=None,
            tipo_cmp=None,
            nro_cmp=None,
            cae=None,
            fecha=None,
            importe=None,
            moneda=None,
            ctz=None,
        )

        # THEN
        (added,) = session.add.call_args.args
        assert added.user_id is None


class TestGet:
    """``get`` projects the stored row, or returns ``None``."""

    async def test_projects_record(self):
        """GIVEN a stored row WHEN get THEN the read model carries its bytes + metadata."""
        # GIVEN
        record = _record()
        session = _session()
        session.execute.return_value = _scalar_result(record)
        store = SqlAlchemyDocumentStore(session)

        # WHEN
        document = await store.get(record.transaction_id, _A_USER)

        # THEN
        assert document is not None
        assert document.pdf_bytes == record.pdf_bytes
        assert document.content_type == "application/pdf"
        assert document.importe == Decimal("150000.50")

    async def test_returns_none_when_absent(self):
        """GIVEN no row WHEN get THEN None comes back."""
        # GIVEN
        session = _session()
        session.execute.return_value = _scalar_result(None)
        store = SqlAlchemyDocumentStore(session)

        # WHEN / THEN
        assert await store.get(uuid4(), _A_USER) is None


class TestExistsByNaturalKey:
    """``exists_by_natural_key`` backs the advisory dedupe flag."""

    async def test_true_when_match(self):
        """GIVEN a matching row WHEN checked THEN True."""
        # GIVEN
        session = _session()
        session.execute.return_value = _first_result((uuid4(),))
        store = SqlAlchemyDocumentStore(session)

        # WHEN / THEN
        assert (
            await store.exists_by_natural_key(emisor_cuit="20304050607", pto_vta="5", tipo_cmp="11", nro_cmp="1234")
            is True
        )

    async def test_false_when_no_match(self):
        """GIVEN no matching row WHEN checked THEN False."""
        # GIVEN
        session = _session()
        session.execute.return_value = _first_result(None)
        store = SqlAlchemyDocumentStore(session)

        # WHEN / THEN
        assert await store.exists_by_natural_key(emisor_cuit="x", pto_vta="1", tipo_cmp="1", nro_cmp="1") is False
