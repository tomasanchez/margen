"""In-memory fakes for the transaction persistence ports.

These mirror the SQLAlchemy adapters' behavior closely enough to drive handler
and reader unit tests without a database: ``add``/``persist`` stage aggregates,
``commit`` makes them visible, ``rollback`` discards uncommitted work, ``delete``
is a hard delete (ADR-030), and the reader lists newest-first by ``occurred_on``
then ``created_at`` (ADR-030).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import TracebackType
from uuid import UUID, uuid4

from margen_api.domain.models.transaction import Transaction
from margen_api.domain.models.value_objects import Kind, TxType
from margen_api.service_layer.document_store import AbstractDocumentStore, InvoiceDocument
from margen_api.service_layer.insights_read_models import MonthlyInsights
from margen_api.service_layer.insights_reader import AbstractInsightsReader
from margen_api.service_layer.monotributo_read_models import (
    MonotributoSnapshot,
    MonotributoStanding,
)
from margen_api.service_layer.monotributo_reader import AbstractMonotributoReader
from margen_api.service_layer.monotributo_repository import (
    AbstractMonotributoSnapshotRepository,
)
from margen_api.service_layer.read_models import TransactionReadModel
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.repository import AbstractTransactionRepository
from margen_api.service_layer.settings_read_models import AppSettings
from margen_api.service_layer.settings_reader import AbstractSettingsReader
from margen_api.service_layer.settings_repository import AbstractSettingsRepository
from margen_api.service_layer.statement_store import AbstractStatementStore, StatementDocument
from margen_api.service_layer.summary_read_models import MonthlySummary
from margen_api.service_layer.summary_reader import AbstractSummaryReader
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Documented default settings used when the fake's settings store is empty (ADR-054).
_DEFAULT_DISPLAY_CURRENCY = "ARS"
_DEFAULT_FX_RATE_TYPE = "MEP"
_DEFAULT_MONOTRIBUTO_CATEGORY = "C"
_DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE = "services"


class FakeTransactionRepository(AbstractTransactionRepository):
    """In-memory repository over a committed store and a staging buffer.

    Both stores are owned by the unit of work: ``add``/``persist`` write to the
    staging buffer, ``commit`` promotes it, ``rollback`` clears it. ``delete`` is
    a hard delete across both stores (ADR-030).
    """

    def __init__(self, committed: dict[UUID, Transaction], staged: dict[UUID, Transaction]) -> None:
        """Initialize the repository over the unit of work's stores.

        Args:
            committed: Aggregates visible after a commit, keyed by id.
            staged: Buffer of aggregates awaiting the next commit, keyed by id.
        """
        self._committed = committed
        self._staged = staged

    def add(self, transaction: Transaction) -> None:
        """Stage a new aggregate until the unit of work commits.

        Ownership rides on the aggregate (``transaction.user_id``), mirroring the
        SQLAlchemy adapter (ADR-108).
        """
        self._staged[transaction.id] = transaction

    async def get(self, transaction_id: UUID, user_id: str) -> Transaction | None:
        """Return the owner's staged/committed aggregate, or ``None`` (ADR-108, ADR-111).

        Mirrors the adapter's owner-scoped lookup: a row owned by another user is
        treated as absent so the handler surfaces a not-found.
        """
        transaction = self._staged.get(transaction_id) or self._committed.get(transaction_id)
        if transaction is None or transaction.user_id != user_id:
            return None
        return transaction

    async def persist(self, transaction: Transaction) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[transaction.id] = transaction

    async def delete(self, transaction_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's aggregate from staged and committed stores (ADR-108).

        A row owned by another user is not removed and reports a miss, so a
        cross-tenant delete surfaces 404 (ADR-111).
        """
        staged = self._staged.get(transaction_id)
        committed = self._committed.get(transaction_id)
        target = staged or committed
        if target is None or target.user_id != user_id:
            return False
        self._staged.pop(transaction_id, None)
        self._committed.pop(transaction_id, None)
        return True


class FakeMonotributoSnapshotRepository(AbstractMonotributoSnapshotRepository):
    """In-memory snapshot history keyed by ``(user_id, period_end)`` (ADR-052, ADR-112).

    Mirrors the SQLAlchemy adapter: ``upsert`` replaces the owner's row for a
    ``period_end`` (idempotent — never duplicates), and the focused read helpers
    return the owner's configured category and the per-window included income that
    the capture handler derives its standings from. Snapshots are scoped to the
    owner so one user's history is independent of another's (ADR-112).
    """

    def __init__(
        self,
        committed: dict[tuple[str, date], MonotributoStanding],
        config: dict[str, str],
        used_by_window: dict[tuple[str, date, date], Decimal],
    ) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._config = config
        self._used_by_window = used_by_window

    async def configured_category(self, user_id: str) -> tuple[str, str] | None:
        """Return the owner's configured ``(category, activity_type)`` pair, if set (ADR-112).

        The fake shares a single settings dict the way ``app_settings`` is the
        single source of truth; ``user_id`` is accepted to mirror the adapter's
        owner-scoped read (ADR-108).
        """
        if not self._config:
            return None
        return self._config["current_category"], self._config["activity_type"]

    async def used_in_window(self, window_start: date, window_end: date, user_id: str) -> Decimal:
        """Return the canned SUM of the owner's included income for a window, else 0 (ADR-112)."""
        return self._used_by_window.get((user_id, window_start, window_end), Decimal(0))

    async def existing_period_ends(self, user_id: str) -> set[date]:
        """Return the owner's ``period_end`` months that already have a snapshot (ADR-112)."""
        return {period_end for (owner, period_end) in self._committed if owner == user_id}

    async def upsert(self, standing: MonotributoStanding, user_id: str) -> None:
        """Insert or update the owner's snapshot for the standing's ``period_end`` (ADR-112)."""
        self._committed[user_id, standing.period_end] = standing


class FakeSettingsRepository(AbstractSettingsRepository):
    """In-memory per-user application settings (ADR-054, ADR-110).

    Mirrors the SQLAlchemy adapter: ``upsert_settings`` merges only the provided
    fields onto a shared settings dict and ``get_settings`` projects it, falling
    back to the documented defaults when a field is unset. ``user_id`` is accepted
    to mirror the owner-scoped adapter (ADR-108, ADR-110); the fake backs a single
    shared dict the way ``configured_category`` does, so unit/route tests drive one
    owner at a time. The Monotributo category/activity share the same backing dict
    the snapshot fake reads from, so ``app_settings`` is the single source of truth
    for the category.
    """

    def __init__(self, settings: dict[str, str]) -> None:
        """Initialize over a shared settings dict."""
        self._settings = settings

    async def get_settings(self, user_id: str) -> AppSettings:
        """Return the owner's persisted settings, falling back to the documented defaults."""
        return self._as_read_model()

    async def upsert_settings(
        self,
        user_id: str,
        *,
        preferred_display_currency: str | None = None,
        fx_default_rate_type: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
    ) -> AppSettings:
        """Merge only the provided fields onto the owner's settings row (ADR-110)."""
        if preferred_display_currency is not None:
            self._settings["preferred_display_currency"] = preferred_display_currency
        if fx_default_rate_type is not None:
            self._settings["fx_default_rate_type"] = fx_default_rate_type
        if monotributo_current_category is not None:
            self._settings["current_category"] = monotributo_current_category
        if monotributo_activity_type is not None:
            self._settings["activity_type"] = monotributo_activity_type
        return self._as_read_model()

    def _as_read_model(self) -> AppSettings:
        """Project the shared dict into an :class:`AppSettings`, applying defaults."""
        return AppSettings(
            preferred_display_currency=self._settings.get("preferred_display_currency", _DEFAULT_DISPLAY_CURRENCY),
            fx_default_rate_type=self._settings.get("fx_default_rate_type", _DEFAULT_FX_RATE_TYPE),
            monotributo_current_category=self._settings.get("current_category", _DEFAULT_MONOTRIBUTO_CATEGORY),
            monotributo_activity_type=self._settings.get("activity_type", _DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE),
        )


class FakeDocumentStore(AbstractDocumentStore):
    """In-memory invoice document store keyed by ``transaction_id`` (ADR-071).

    Mirrors the SQLAlchemy adapter closely enough to keep the suite constructing
    the unit of work: ``save`` writes one row, ``get`` projects it into the
    download read model, and ``exists_by_natural_key`` backs the advisory dedupe
    check (warn, not block). Thorough behavior is covered by the integration tier
    (ADR-074).
    """

    def __init__(self, committed: dict[UUID, InvoiceDocument], owners: dict[UUID, str | None]) -> None:
        """Initialize the store over the unit of work's committed dict.

        Ownership is tracked in a side map (the download read model intentionally
        carries no ``user_id``), keyed by ``transaction_id``, so ``get`` can mirror
        the adapter's owner-scoped lookup (ADR-108, ADR-111).
        """
        self._committed = committed
        self._owners = owners

    async def save(
        self,
        *,
        transaction_id: UUID,
        user_id: str | None,
        pdf_bytes: bytes,
        content_type: str,
        byte_size: int,
        extracted_text: str | None,
        qr_json: dict | None,
        emisor_cuit: str | None,
        pto_vta: str | None,
        tipo_cmp: str | None,
        nro_cmp: str | None,
        cae: str | None,
        fecha: date | None,
        importe: Decimal | None,
        moneda: str | None,
        ctz: Decimal | None,
    ) -> None:
        """Store one document row keyed by ``transaction_id``, owned by ``user_id`` (ADR-108)."""
        self._owners[transaction_id] = user_id
        self._committed[transaction_id] = InvoiceDocument(
            transaction_id=transaction_id,
            pdf_bytes=pdf_bytes,
            content_type=content_type,
            byte_size=byte_size,
            extracted_text=extracted_text,
            qr_json=qr_json,
            emisor_cuit=emisor_cuit,
            pto_vta=pto_vta,
            tipo_cmp=tipo_cmp,
            nro_cmp=nro_cmp,
            cae=cae,
            fecha=fecha,
            importe=importe,
            moneda=moneda,
            ctz=ctz,
        )

    async def get(self, transaction_id: UUID, user_id: str) -> InvoiceDocument | None:
        """Return the owner's stored document for a transaction, or ``None`` (ADR-108, ADR-111).

        Mirrors the adapter's owner-scoped lookup: a document owned by another user is
        treated as absent so the download surfaces a 404 before any bytes are read.
        """
        if self._owners.get(transaction_id) != user_id:
            return None
        return self._committed.get(transaction_id)

    async def exists_by_natural_key(
        self,
        *,
        emisor_cuit: str | None,
        pto_vta: str | None,
        tipo_cmp: str | None,
        nro_cmp: str | None,
    ) -> bool:
        """Return whether a stored document matches the invoice natural key."""
        return any(
            document.emisor_cuit == emisor_cuit
            and document.pto_vta == pto_vta
            and document.tipo_cmp == tipo_cmp
            and document.nro_cmp == nro_cmp
            for document in self._committed.values()
        )


class FakeStatementStore(AbstractStatementStore):
    """In-memory statement document store keyed by a generated id (ADR-077).

    Mirrors the SQLAlchemy adapter closely enough to drive the import handler and
    parse-endpoint dedupe without a database: ``save`` writes one row under a
    freshly generated UUID and returns that id (the FK target every imported
    transaction links back to), ``get`` projects it into the download read model,
    and ``exists_by_natural_key`` backs the advisory dedupe check (warn, not
    block). Thorough behavior is covered by the integration tier (ADR-082).
    """

    def __init__(self, committed: dict[UUID, StatementDocument], owners: dict[UUID, str | None]) -> None:
        """Initialize the store over the unit of work's committed dict.

        Ownership is tracked in a side map (the download read model intentionally
        carries no ``user_id``), keyed by the generated document id, so ``get`` can
        mirror the adapter's owner-scoped lookup (ADR-108, ADR-111).
        """
        self._committed = committed
        self._owners = owners

    async def save(
        self,
        *,
        user_id: str | None,
        pdf_bytes: bytes,
        content_type: str,
        byte_size: int,
        extracted_text: str | None,
        bank_name: str | None,
        network: str | None,
        card_last4: str | None,
        issuer_cuit: str | None,
        statement_number: str | None,
        period_close: date | None,
        period_due: date | None,
        total_amount: Decimal | None,
    ) -> UUID:
        """Store one document row under a generated id, owned by ``user_id`` (ADR-108)."""
        document_id = uuid4()
        self._owners[document_id] = user_id
        self._committed[document_id] = StatementDocument(
            id=document_id,
            pdf_bytes=pdf_bytes,
            content_type=content_type,
            byte_size=byte_size,
            extracted_text=extracted_text,
            bank_name=bank_name,
            network=network,
            card_last4=card_last4,
            issuer_cuit=issuer_cuit,
            statement_number=statement_number,
            period_close=period_close,
            period_due=period_due,
            total_amount=total_amount,
        )
        return document_id

    async def get(self, statement_document_id: UUID, user_id: str) -> StatementDocument | None:
        """Return the owner's stored document by identity, or ``None`` (ADR-108, ADR-111).

        Mirrors the adapter's owner-scoped lookup: a document owned by another user is
        treated as absent so the download surfaces a 404 before any bytes are read.
        """
        if self._owners.get(statement_document_id) != user_id:
            return None
        return self._committed.get(statement_document_id)

    async def exists_by_natural_key(
        self,
        *,
        issuer_cuit: str | None,
        card_last4: str | None,
        statement_number: str | None,
    ) -> bool:
        """Return whether a stored document matches the statement natural key."""
        return any(
            document.issuer_cuit == issuer_cuit
            and document.card_last4 == card_last4
            and document.statement_number == statement_number
            for document in self._committed.values()
        )


class FakeUnitOfWork(AbstractUnitOfWork):
    """In-memory unit of work exposing the write-side repositories.

    Beyond the transaction repository it exposes fake Monotributo snapshot and
    application-settings repositories (ADR-052, ADR-054) so the read-records
    capture and settings handlers can be driven without a database. ``snapshots``
    is the committed snapshot history keyed by ``(user_id, period_end)`` so each
    owner's history is independent (ADR-112); ``config`` is the single-row settings
    dict (the Monotributo category/activity live here too, ADR-054);
    ``used_by_window`` seeds the per-owner per-window included-income totals the
    capture handler reads, keyed by ``(user_id, window_start, window_end)``.
    """

    def __init__(self) -> None:
        """Initialize an empty unit of work."""
        self.committed_aggregates: dict[UUID, Transaction] = {}
        self._staged: dict[UUID, Transaction] = {}
        self.snapshots: dict[tuple[str, date], MonotributoStanding] = {}
        self.config: dict[str, str] = {}
        self.used_by_window: dict[tuple[str, date, date], Decimal] = {}
        self.documents_store: dict[UUID, InvoiceDocument] = {}
        self.document_owners: dict[UUID, str | None] = {}
        self.statements_store: dict[UUID, StatementDocument] = {}
        self.statement_owners: dict[UUID, str | None] = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.monotributo_snapshots = FakeMonotributoSnapshotRepository(self.snapshots, self.config, self.used_by_window)
        self.settings = FakeSettingsRepository(self.config)
        self.documents = FakeDocumentStore(self.documents_store, self.document_owners)
        self.statements = FakeStatementStore(self.statements_store, self.statement_owners)
        self.committed = False

    async def __aenter__(self) -> FakeUnitOfWork:
        """Enter the transaction boundary with a fresh staging buffer."""
        self.committed = False
        self._staged = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.monotributo_snapshots = FakeMonotributoSnapshotRepository(self.snapshots, self.config, self.used_by_window)
        self.settings = FakeSettingsRepository(self.config)
        self.documents = FakeDocumentStore(self.documents_store, self.document_owners)
        self.statements = FakeStatementStore(self.statements_store, self.statement_owners)
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Roll back work that did not explicitly commit."""
        await super().__aexit__(exception_type, exception, traceback)

    async def commit(self) -> None:
        """Make staged aggregates visible to later reads."""
        self.committed_aggregates.update(self._staged)
        self._staged.clear()
        self.committed = True

    async def flush(self) -> None:
        """Materialize staged aggregates within the transaction (no commit)."""
        # Mirror a real flush: staged rows become visible to later reads in the
        # same unit of work; commit still promotes + clears them.
        self.committed_aggregates.update(self._staged)

    async def rollback(self) -> None:
        """Discard staged aggregates."""
        self._staged.clear()


class FakeTransactionReader(AbstractTransactionReader):
    """In-memory reader projecting a committed store into read models."""

    def __init__(self, committed: dict[UUID, Transaction]) -> None:
        """Initialize the reader over a committed store.

        Args:
            committed: The aggregates to project, keyed by id. Pass a unit of
                work's ``committed_aggregates`` to share state.
        """
        self._committed = committed

    async def list_transactions(self, user_id: str) -> list[TransactionReadModel]:
        """List the owner's read models newest-first by ``occurred_on`` then ``created_at`` (ADR-108)."""
        owned = [tx for tx in self._committed.values() if tx.user_id == user_id]
        ordered = sorted(
            owned,
            key=lambda tx: (tx.occurred_on, tx.created_at),
            reverse=True,
        )
        return [_project(tx) for tx in ordered]

    async def get_transaction(self, transaction_id: UUID, user_id: str) -> TransactionReadModel | None:
        """Return the owner's read model, or ``None`` when absent/cross-tenant (ADR-108, ADR-111)."""
        transaction = self._committed.get(transaction_id)
        if transaction is None or transaction.user_id != user_id:
            return None
        return _project(transaction)


class FakeSummaryReader(AbstractSummaryReader):
    """Summary reader returning a canned :class:`MonthlySummary` for route tests.

    The route tests assert wiring and the HTTP contract, not the aggregation
    itself (which the pure-function and integration tiers cover), so this fake
    simply records the requested month and returns the summary it was given.
    """

    def __init__(self, summary: MonthlySummary) -> None:
        """Initialize the reader with the summary it should return.

        Args:
            summary: The monthly summary every call returns.
        """
        self._summary = summary
        self.requested_month: date | None = None
        self.requested_user_id: str | None = None

    async def monthly_summary(self, month: date, user_id: str) -> MonthlySummary:
        """Record the requested month and owner and return the canned summary (ADR-108)."""
        self.requested_month = month
        self.requested_user_id = user_id
        return self._summary


class FakeInsightsReader(AbstractInsightsReader):
    """Insights reader returning a canned :class:`MonthlyInsights` for route tests.

    The route tests assert wiring and the HTTP contract, not the aggregation
    itself (which the pure-function and integration tiers cover), so this fake
    records the requested month and reference and returns the insights it was
    given (ADR-061, ADR-032).
    """

    def __init__(self, insights: MonthlyInsights) -> None:
        """Initialize the reader with the insights every call returns.

        Args:
            insights: The monthly insights every call returns.
        """
        self._insights = insights
        self.requested_month: date | None = None
        self.requested_reference: date | None = None
        self.requested_user_id: str | None = None

    async def monthly_insights(self, month: date, reference: date, user_id: str) -> MonthlyInsights:
        """Record the requested month, reference and owner and return the canned facts (ADR-108)."""
        self.requested_month = month
        self.requested_reference = reference
        self.requested_user_id = user_id
        return self._insights


class FakeMonotributoReader(AbstractMonotributoReader):
    """Monotributo reader returning a canned snapshot for route tests (ADR-052).

    The route tests assert wiring and the HTTP contract, not the aggregation
    (covered by the pure-function and integration tiers), so this fake records the
    requested reference date and returns the snapshot it was given.
    """

    def __init__(self, snapshot: MonotributoSnapshot) -> None:
        """Initialize the reader with the snapshot every call returns."""
        self._snapshot = snapshot
        self.requested_reference: date | None = None
        self.requested_user_id: str | None = None

    async def snapshot(self, reference: date, user_id: str) -> MonotributoSnapshot:
        """Record the reference and owner and return the canned snapshot (ADR-112)."""
        self.requested_reference = reference
        self.requested_user_id = user_id
        return self._snapshot

    async def current_standing(self, reference: date, user_id: str) -> MonotributoStanding:
        """Record the reference and owner and return the canned current standing (ADR-112)."""
        self.requested_reference = reference
        self.requested_user_id = user_id
        return self._snapshot.current


class FakeSettingsReader(AbstractSettingsReader):
    """Settings reader projecting a shared settings dict for route tests (ADR-054, ADR-110).

    Mirrors :class:`FakeSettingsRepository`'s read side so the GET route returns
    the documented defaults when a field is unset, and -- when backed by a unit of
    work's ``config`` dict -- reflects writes a PATCH committed through that unit of
    work (the e2e round-trip), all without a database (ADR-032). ``user_id`` is
    accepted to mirror the owner-scoped adapter (ADR-108, ADR-110); the fake backs a
    single shared dict, so route tests drive one owner at a time.
    """

    def __init__(self, settings: dict[str, str]) -> None:
        """Initialize over a shared settings dict."""
        self._settings = settings

    async def get_settings(self, user_id: str) -> AppSettings:
        """Project the owner's shared dict into an :class:`AppSettings`, applying defaults."""
        return AppSettings(
            preferred_display_currency=self._settings.get("preferred_display_currency", _DEFAULT_DISPLAY_CURRENCY),
            fx_default_rate_type=self._settings.get("fx_default_rate_type", _DEFAULT_FX_RATE_TYPE),
            monotributo_current_category=self._settings.get("current_category", _DEFAULT_MONOTRIBUTO_CATEGORY),
            monotributo_activity_type=self._settings.get("activity_type", _DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE),
        )


def _project(transaction: Transaction) -> TransactionReadModel:
    """Project a domain aggregate into a read model, deriving ``type``."""
    return TransactionReadModel(
        id=transaction.id,
        occurred_on=transaction.occurred_on,
        name=transaction.name,
        kind=transaction.kind,
        type=TxType.EXPENSE if transaction.kind is Kind.EXPENSE else TxType.INCOME,
        amount=transaction.amount,
        currency=transaction.currency,
        usd_amount=transaction.usd_amount,
        fx_rate=transaction.fx_rate,
        fx_rate_type=transaction.fx_rate_type,
        fx_rate_as_of=transaction.fx_rate_as_of,
        category=transaction.category,
        payment_method=transaction.payment_method,
        card=transaction.card,
        notes=transaction.notes,
        recurring=transaction.recurring,
        counts_toward_monotributo=transaction.counts_toward_monotributo,
        statement_document_id=transaction.statement_document_id,
        created_at=transaction.created_at,
        updated_at=transaction.updated_at,
    )
