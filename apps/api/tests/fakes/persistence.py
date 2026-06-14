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
from uuid import UUID

from margen_api.domain.models.transaction import Transaction
from margen_api.domain.models.value_objects import Kind, TxType
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
        """Stage a new aggregate until the unit of work commits."""
        self._staged[transaction.id] = transaction

    async def get(self, transaction_id: UUID) -> Transaction | None:
        """Return a staged or committed aggregate, or ``None`` when absent."""
        return self._staged.get(transaction_id) or self._committed.get(transaction_id)

    async def persist(self, transaction: Transaction) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[transaction.id] = transaction

    async def delete(self, transaction_id: UUID) -> bool:
        """Hard-delete an aggregate from staged and committed stores."""
        staged = self._staged.pop(transaction_id, None)
        committed = self._committed.pop(transaction_id, None)
        return staged is not None or committed is not None


class FakeMonotributoSnapshotRepository(AbstractMonotributoSnapshotRepository):
    """In-memory snapshot history keyed by ``period_end`` month (ADR-052).

    Mirrors the SQLAlchemy adapter: ``upsert`` replaces the row for a
    ``period_end`` (idempotent — never duplicates), and the focused read helpers
    return the unit of work's configured category and the per-window included
    income that the capture handler derives its standings from.
    """

    def __init__(
        self,
        committed: dict[date, MonotributoStanding],
        config: dict[str, str],
        used_by_window: dict[tuple[date, date], Decimal],
    ) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._config = config
        self._used_by_window = used_by_window

    async def configured_category(self) -> tuple[str, str] | None:
        """Return the configured ``(category, activity_type)`` pair, if set."""
        if not self._config:
            return None
        return self._config["current_category"], self._config["activity_type"]

    async def used_in_window(self, window_start: date, window_end: date) -> Decimal:
        """Return the canned SUM of included income for a window, else 0."""
        return self._used_by_window.get((window_start, window_end), Decimal(0))

    async def existing_period_ends(self) -> set[date]:
        """Return the ``period_end`` months that already have a snapshot."""
        return set(self._committed)

    async def upsert(self, standing: MonotributoStanding) -> None:
        """Insert or update the snapshot for the standing's ``period_end``."""
        self._committed[standing.period_end] = standing


class FakeSettingsRepository(AbstractSettingsRepository):
    """In-memory single-row application settings (ADR-054).

    Mirrors the SQLAlchemy adapter: ``upsert_settings`` merges only the provided
    fields onto a shared single-row dict and ``get_settings`` projects it, falling
    back to the documented defaults when a field is unset. The Monotributo
    category/activity share the same backing dict the snapshot fake reads from, so
    ``app_settings`` is the single source of truth for the category.
    """

    def __init__(self, settings: dict[str, str]) -> None:
        """Initialize over a shared single-row settings dict."""
        self._settings = settings

    async def get_settings(self) -> AppSettings:
        """Return the persisted settings, falling back to the documented defaults."""
        return self._as_read_model()

    async def upsert_settings(
        self,
        *,
        preferred_display_currency: str | None = None,
        fx_default_rate_type: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
    ) -> AppSettings:
        """Merge only the provided fields onto the single settings row."""
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


class FakeUnitOfWork(AbstractUnitOfWork):
    """In-memory unit of work exposing the write-side repositories.

    Beyond the transaction repository it exposes fake Monotributo snapshot and
    application-settings repositories (ADR-052, ADR-054) so the read-records
    capture and settings handlers can be driven without a database. ``snapshots``
    is the committed snapshot history keyed by ``period_end``; ``config`` is the
    single-row settings dict (the Monotributo category/activity live here too,
    ADR-054); ``used_by_window`` seeds the per-window included-income totals the
    capture handler reads.
    """

    def __init__(self) -> None:
        """Initialize an empty unit of work."""
        self.committed_aggregates: dict[UUID, Transaction] = {}
        self._staged: dict[UUID, Transaction] = {}
        self.snapshots: dict[date, MonotributoStanding] = {}
        self.config: dict[str, str] = {}
        self.used_by_window: dict[tuple[date, date], Decimal] = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.monotributo_snapshots = FakeMonotributoSnapshotRepository(self.snapshots, self.config, self.used_by_window)
        self.settings = FakeSettingsRepository(self.config)
        self.committed = False

    async def __aenter__(self) -> FakeUnitOfWork:
        """Enter the transaction boundary with a fresh staging buffer."""
        self.committed = False
        self._staged = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.monotributo_snapshots = FakeMonotributoSnapshotRepository(self.snapshots, self.config, self.used_by_window)
        self.settings = FakeSettingsRepository(self.config)
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

    async def list_transactions(self) -> list[TransactionReadModel]:
        """List read models newest-first by ``occurred_on`` then ``created_at``."""
        ordered = sorted(
            self._committed.values(),
            key=lambda tx: (tx.occurred_on, tx.created_at),
            reverse=True,
        )
        return [_project(tx) for tx in ordered]

    async def get_transaction(self, transaction_id: UUID) -> TransactionReadModel | None:
        """Return one read model, or ``None`` when absent."""
        transaction = self._committed.get(transaction_id)
        return _project(transaction) if transaction is not None else None


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

    async def monthly_summary(self, month: date) -> MonthlySummary:
        """Record the requested month and return the canned summary."""
        self.requested_month = month
        return self._summary


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

    async def snapshot(self, reference: date) -> MonotributoSnapshot:
        """Record the reference and return the canned snapshot."""
        self.requested_reference = reference
        return self._snapshot

    async def current_standing(self, reference: date) -> MonotributoStanding:
        """Return the canned snapshot's current standing."""
        self.requested_reference = reference
        return self._snapshot.current


class FakeSettingsReader(AbstractSettingsReader):
    """Settings reader projecting a shared single-row dict for route tests (ADR-054).

    Mirrors :class:`FakeSettingsRepository`'s read side so the GET route returns
    the documented defaults when a field is unset, and -- when backed by a unit of
    work's ``config`` dict -- reflects writes a PATCH committed through that unit of
    work (the e2e round-trip), all without a database (ADR-032).
    """

    def __init__(self, settings: dict[str, str]) -> None:
        """Initialize over a shared single-row settings dict."""
        self._settings = settings

    async def get_settings(self) -> AppSettings:
        """Project the shared dict into an :class:`AppSettings`, applying defaults."""
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
        notes=transaction.notes,
        recurring=transaction.recurring,
        counts_toward_monotributo=transaction.counts_toward_monotributo,
        created_at=transaction.created_at,
        updated_at=transaction.updated_at,
    )
