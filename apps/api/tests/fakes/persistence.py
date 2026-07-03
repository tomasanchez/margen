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

from margen_api.domain.models.account import Account
from margen_api.domain.models.budget import Budget
from margen_api.domain.models.budget_income import BudgetIncome
from margen_api.domain.models.institution import Institution
from margen_api.domain.models.transaction import Transaction
from margen_api.domain.models.transfer import Transfer
from margen_api.domain.models.value_objects import BudgetKind, Currency, Kind, TxType
from margen_api.service_layer.account_read_models import (
    AccountReadModel,
    CcBalanceNative,
    InstallmentsNative,
    Liabilities,
    NetWorth,
)
from margen_api.service_layer.account_reader import AbstractAccountReader
from margen_api.service_layer.account_repository import AbstractAccountRepository
from margen_api.service_layer.budget_income_repository import AbstractBudgetIncomeRepository
from margen_api.service_layer.budget_read_models import CategoryHistory, MonthlyBudget
from margen_api.service_layer.budget_reader import AbstractBudgetReader
from margen_api.service_layer.budget_repository import AbstractBudgetRepository
from margen_api.service_layer.committed_read_models import CommittedSplit
from margen_api.service_layer.committed_reader import AbstractCommittedReader
from margen_api.service_layer.document_store import AbstractDocumentStore, InvoiceDocument
from margen_api.service_layer.forecast_read_models import ForecastSeries
from margen_api.service_layer.forecast_reader import AbstractForecastReader
from margen_api.service_layer.insights_read_models import MonthlyInsights
from margen_api.service_layer.insights_reader import AbstractInsightsReader
from margen_api.service_layer.institution_read_models import InstitutionReadModel
from margen_api.service_layer.institution_reader import AbstractInstitutionReader
from margen_api.service_layer.institution_repository import AbstractInstitutionRepository
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
from margen_api.service_layer.reports_overview_read_models import ReportsOverview
from margen_api.service_layer.reports_read_models import NetWorthHistory
from margen_api.service_layer.reports_reader import AbstractReportsReader
from margen_api.service_layer.repository import AbstractTransactionRepository
from margen_api.service_layer.settings_read_models import AppSettings
from margen_api.service_layer.settings_reader import AbstractSettingsReader
from margen_api.service_layer.settings_repository import AbstractSettingsRepository
from margen_api.service_layer.statement_store import AbstractStatementStore, StatementDocument
from margen_api.service_layer.summary_read_models import MonthlySummary
from margen_api.service_layer.summary_reader import AbstractSummaryReader
from margen_api.service_layer.transfer_read_models import TransferReadModel
from margen_api.service_layer.transfer_reader import AbstractTransferReader
from margen_api.service_layer.transfer_repository import AbstractTransferRepository
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Documented default settings used when the fake's settings store is empty (ADR-054).
_DEFAULT_DISPLAY_CURRENCY = "ARS"
_DEFAULT_FX_RATE_TYPE = "MEP"
_DEFAULT_PREFERRED_RATE_SOURCE = "bolsa"
_DEFAULT_MONOTRIBUTO_CATEGORY = "C"
_DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE = "services"
# Brand-new users default to the Monotributo module OFF (ADR-126).
_DEFAULT_MONOTRIBUTO_ENABLED = False


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


class FakeAccountRepository(AbstractAccountRepository):
    """In-memory account repository over a committed store and a staging buffer.

    Mirrors :class:`FakeTransactionRepository`: ``add``/``persist`` write to the
    staging buffer, ``commit`` promotes it, ``rollback`` clears it, and every
    lookup is owner-scoped (ADR-130).
    """

    def __init__(self, committed: dict[UUID, Account], staged: dict[UUID, Account]) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._staged = staged

    def add(self, account: Account) -> None:
        """Stage a new aggregate until the unit of work commits (ADR-130)."""
        self._staged[account.id] = account

    async def get(self, account_id: UUID, user_id: str) -> Account | None:
        """Return the owner's staged/committed aggregate, or ``None`` (ADR-130, ADR-111)."""
        account = self._staged.get(account_id) or self._committed.get(account_id)
        if account is None or account.user_id != user_id:
            return None
        return account

    async def persist(self, account: Account) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[account.id] = account

    async def owns(self, account_id: UUID, user_id: str) -> bool:
        """Return whether the owner has an account with ``account_id`` (ADR-130)."""
        return await self.get(account_id, user_id) is not None


class FakeInstitutionRepository(AbstractInstitutionRepository):
    """In-memory institution repository over a committed store and a staging buffer.

    Mirrors :class:`FakeAccountRepository`: ``add``/``persist`` write to the
    staging buffer, ``commit`` promotes it, ``rollback`` clears it, and every
    lookup is owner-scoped (ADR-130, ADR-134).
    """

    def __init__(self, committed: dict[UUID, Institution], staged: dict[UUID, Institution]) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._staged = staged

    def add(self, institution: Institution) -> None:
        """Stage a new aggregate until the unit of work commits (ADR-130)."""
        self._staged[institution.id] = institution

    async def get(self, institution_id: UUID, user_id: str) -> Institution | None:
        """Return the owner's staged/committed aggregate, or ``None`` (ADR-130, ADR-111)."""
        institution = self._staged.get(institution_id) or self._committed.get(institution_id)
        if institution is None or institution.user_id != user_id:
            return None
        return institution

    async def persist(self, institution: Institution) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[institution.id] = institution

    async def owns(self, institution_id: UUID, user_id: str) -> bool:
        """Return whether the owner has an institution with ``institution_id`` (ADR-130)."""
        return await self.get(institution_id, user_id) is not None


class FakeTransferRepository(AbstractTransferRepository):
    """In-memory transfer repository over a committed store and a staging buffer.

    Mirrors :class:`FakeAccountRepository`: ``add`` writes to the staging buffer,
    ``commit`` promotes it, ``rollback`` clears it, and ``delete`` is an owner-scoped
    hard delete across both stores (ADR-135, ADR-130).
    """

    def __init__(self, committed: dict[UUID, Transfer], staged: dict[UUID, Transfer]) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._staged = staged

    def add(self, transfer: Transfer) -> None:
        """Stage a new aggregate until the unit of work commits (ADR-130)."""
        self._staged[transfer.id] = transfer

    async def delete(self, transfer_id: UUID, user_id: str) -> bool:
        """Hard-delete the owner's aggregate from staged and committed stores (ADR-130).

        A row owned by another user is not removed and reports a miss, so a
        cross-tenant delete surfaces 404 (ADR-111). The fee expenses are independent
        transactions and are untouched (ADR-135).
        """
        staged = self._staged.get(transfer_id)
        committed = self._committed.get(transfer_id)
        target = staged or committed
        if target is None or target.user_id != user_id:
            return False
        self._staged.pop(transfer_id, None)
        self._committed.pop(transfer_id, None)
        return True


class FakeBudgetRepository(AbstractBudgetRepository):
    """In-memory budget repository over a committed store and a staging buffer.

    Mirrors :class:`FakeAccountRepository`: ``add``/``persist`` write to the staging
    buffer, ``commit`` promotes it, ``rollback`` clears it. The natural-key lookup
    resolves ``(category, period)`` scoped to the owner so the upsert handler can
    replace rather than duplicate (ADR-125), and ``delete`` is an owner-scoped hard
    delete by the same key (ADR-130).
    """

    def __init__(self, committed: dict[UUID, Budget], staged: dict[UUID, Budget]) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._staged = staged

    def add(self, budget: Budget) -> None:
        """Stage a new aggregate until the unit of work commits (ADR-130)."""
        self._staged[budget.id] = budget

    async def get_by_category_period(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> Budget | None:
        """Return the owner's row for a kind/category/month, or ``None`` (ADR-138, ADR-130)."""
        for store in (self._staged, self._committed):
            for budget in store.values():
                if (
                    budget.user_id == user_id
                    and budget.kind == kind
                    and budget.category == category
                    and budget.period == period
                ):
                    return budget
        return None

    async def list_by_period(
        self,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> list[Budget]:
        """List the owner's rows of a kind for a month across both stores (ADR-137, ADR-130)."""
        seen: dict[UUID, Budget] = {}
        for store in (self._committed, self._staged):
            for budget in store.values():
                if budget.user_id == user_id and budget.kind == kind and budget.period == period:
                    seen[budget.id] = budget
        return list(seen.values())

    async def persist(self, budget: Budget) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[budget.id] = budget

    async def delete(
        self,
        category: str,
        period: date,
        user_id: str,
        kind: BudgetKind = BudgetKind.SPEND,
    ) -> bool:
        """Hard-delete the owner's row for a kind/category/month across both stores (ADR-138, ADR-130)."""
        removed = False
        for store in (self._staged, self._committed):
            for budget_id, budget in list(store.items()):
                if (
                    budget.user_id == user_id
                    and budget.kind == kind
                    and budget.category == category
                    and budget.period == period
                ):
                    store.pop(budget_id, None)
                    removed = True
        return removed


class FakeBudgetIncomeRepository(AbstractBudgetIncomeRepository):
    """In-memory income-base repository over a committed store and a staging buffer.

    Mirrors :class:`FakeBudgetRepository`: ``add``/``persist`` write to the staging
    buffer, ``commit`` promotes it, ``rollback`` clears it, and the natural-key lookup
    resolves ``period`` scoped to the owner so the upsert handler can replace rather
    than duplicate (ADR-139, ADR-130).
    """

    def __init__(self, committed: dict[UUID, BudgetIncome], staged: dict[UUID, BudgetIncome]) -> None:
        """Initialize the repository over the unit of work's stores."""
        self._committed = committed
        self._staged = staged

    def add(self, income: BudgetIncome) -> None:
        """Stage a new aggregate until the unit of work commits (ADR-130)."""
        self._staged[income.id] = income

    async def get_by_period(self, period: date, user_id: str) -> BudgetIncome | None:
        """Return the owner's income base for a month, or ``None`` (ADR-139, ADR-130)."""
        for store in (self._staged, self._committed):
            for income in store.values():
                if income.user_id == user_id and income.period == period:
                    return income
        return None

    async def persist(self, income: BudgetIncome) -> None:
        """Stage a mutated aggregate for the next commit."""
        self._staged[income.id] = income


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
        config: dict[str, str | bool],
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
        return str(self._config["current_category"]), str(self._config["activity_type"])

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

    def __init__(self, settings: dict[str, str | bool]) -> None:
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
        preferred_rate_source: str | None = None,
        monotributo_current_category: str | None = None,
        monotributo_activity_type: str | None = None,
        monotributo_enabled: bool | None = None,
    ) -> AppSettings:
        """Merge only the provided fields onto the owner's settings row (ADR-110, ADR-126, ADR-151)."""
        if preferred_display_currency is not None:
            self._settings["preferred_display_currency"] = preferred_display_currency
        if fx_default_rate_type is not None:
            self._settings["fx_default_rate_type"] = fx_default_rate_type
        if preferred_rate_source is not None:
            self._settings["preferred_rate_source"] = preferred_rate_source
        if monotributo_current_category is not None:
            self._settings["current_category"] = monotributo_current_category
        if monotributo_activity_type is not None:
            self._settings["activity_type"] = monotributo_activity_type
        if monotributo_enabled is not None:
            self._settings["monotributo_enabled"] = monotributo_enabled
        return self._as_read_model()

    def _as_read_model(self) -> AppSettings:
        """Project the shared dict into an :class:`AppSettings`, applying defaults."""
        return AppSettings(
            preferred_display_currency=str(self._settings.get("preferred_display_currency", _DEFAULT_DISPLAY_CURRENCY)),
            fx_default_rate_type=str(self._settings.get("fx_default_rate_type", _DEFAULT_FX_RATE_TYPE)),
            preferred_rate_source=str(self._settings.get("preferred_rate_source", _DEFAULT_PREFERRED_RATE_SOURCE)),
            monotributo_current_category=str(self._settings.get("current_category", _DEFAULT_MONOTRIBUTO_CATEGORY)),
            monotributo_activity_type=str(self._settings.get("activity_type", _DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE)),
            monotributo_enabled=bool(self._settings.get("monotributo_enabled", _DEFAULT_MONOTRIBUTO_ENABLED)),
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
        self.committed_accounts: dict[UUID, Account] = {}
        self._staged_accounts: dict[UUID, Account] = {}
        self.committed_institutions: dict[UUID, Institution] = {}
        self._staged_institutions: dict[UUID, Institution] = {}
        self.committed_transfers: dict[UUID, Transfer] = {}
        self._staged_transfers: dict[UUID, Transfer] = {}
        self.committed_budgets: dict[UUID, Budget] = {}
        self._staged_budgets: dict[UUID, Budget] = {}
        self.committed_budget_income: dict[UUID, BudgetIncome] = {}
        self._staged_budget_income: dict[UUID, BudgetIncome] = {}
        self.snapshots: dict[tuple[str, date], MonotributoStanding] = {}
        self.config: dict[str, str | bool] = {}
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
        self.accounts = FakeAccountRepository(self.committed_accounts, self._staged_accounts)
        self.institutions = FakeInstitutionRepository(self.committed_institutions, self._staged_institutions)
        self.transfers = FakeTransferRepository(self.committed_transfers, self._staged_transfers)
        self.budgets = FakeBudgetRepository(self.committed_budgets, self._staged_budgets)
        self.budget_income = FakeBudgetIncomeRepository(self.committed_budget_income, self._staged_budget_income)
        self.committed = False

    async def __aenter__(self) -> FakeUnitOfWork:
        """Enter the transaction boundary with a fresh staging buffer."""
        self.committed = False
        self._staged = {}
        self._staged_accounts = {}
        self._staged_institutions = {}
        self._staged_transfers = {}
        self._staged_budgets = {}
        self._staged_budget_income = {}
        self.transactions = FakeTransactionRepository(self.committed_aggregates, self._staged)
        self.monotributo_snapshots = FakeMonotributoSnapshotRepository(self.snapshots, self.config, self.used_by_window)
        self.settings = FakeSettingsRepository(self.config)
        self.documents = FakeDocumentStore(self.documents_store, self.document_owners)
        self.statements = FakeStatementStore(self.statements_store, self.statement_owners)
        self.accounts = FakeAccountRepository(self.committed_accounts, self._staged_accounts)
        self.institutions = FakeInstitutionRepository(self.committed_institutions, self._staged_institutions)
        self.transfers = FakeTransferRepository(self.committed_transfers, self._staged_transfers)
        self.budgets = FakeBudgetRepository(self.committed_budgets, self._staged_budgets)
        self.budget_income = FakeBudgetIncomeRepository(self.committed_budget_income, self._staged_budget_income)
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
        self.committed_accounts.update(self._staged_accounts)
        self.committed_institutions.update(self._staged_institutions)
        self.committed_transfers.update(self._staged_transfers)
        self.committed_budgets.update(self._staged_budgets)
        self.committed_budget_income.update(self._staged_budget_income)
        self._staged.clear()
        self._staged_accounts.clear()
        self._staged_institutions.clear()
        self._staged_transfers.clear()
        self._staged_budgets.clear()
        self._staged_budget_income.clear()
        self.committed = True

    async def flush(self) -> None:
        """Materialize staged aggregates within the transaction (no commit)."""
        # Mirror a real flush: staged rows become visible to later reads in the
        # same unit of work; commit still promotes + clears them.
        self.committed_aggregates.update(self._staged)
        self.committed_accounts.update(self._staged_accounts)
        self.committed_institutions.update(self._staged_institutions)
        self.committed_transfers.update(self._staged_transfers)
        self.committed_budgets.update(self._staged_budgets)
        self.committed_budget_income.update(self._staged_budget_income)

    async def rollback(self) -> None:
        """Discard staged aggregates."""
        self._staged.clear()
        self._staged_accounts.clear()
        self._staged_institutions.clear()
        self._staged_transfers.clear()
        self._staged_budgets.clear()
        self._staged_budget_income.clear()


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


def _empty_net_worth() -> NetWorth:
    """Build a zero ARS net worth with an empty liabilities reservation (ADR-180)."""
    return NetWorth(
        total=Decimal(0),
        currency=Currency.ARS,
        accounts=[],
        liabilities=Liabilities(
            installments=Decimal(0),
            installments_native=InstallmentsNative(ars=Decimal(0), usd=Decimal(0)),
            cc_balance=Decimal(0),
            cc_balance_native=CcBalanceNative(ars=Decimal(0), usd=Decimal(0)),
            other=None,
            total=Decimal(0),
        ),
        net_after_liabilities=Decimal(0),
    )


class FakeAccountReader(AbstractAccountReader):
    """In-memory account reader projecting committed accounts (ADR-122, ADR-130, ADR-134).

    Mirrors :class:`FakeTransactionReader` for the accounts list (owner-scoped,
    newest-first by creation), joining each account to its institution for the
    denormalized ``name``/``type`` (ADR-134). For net worth the route tests assert
    the wiring and the HTTP contract, not the aggregation (covered by the
    pure-function and integration tiers), so ``net_worth`` returns the canned value
    it was given and records the requested owner.
    """

    def __init__(
        self,
        committed: dict[UUID, Account],
        institutions: dict[UUID, Institution] | None = None,
        net_worth: NetWorth | None = None,
    ) -> None:
        """Initialize over a committed account store and an optional canned net worth.

        Args:
            committed: The accounts to project, keyed by id. Pass a unit of work's
                ``committed_accounts`` to share state.
            institutions: The institutions to join for name/type, keyed by id. Pass
                a unit of work's ``committed_institutions`` to share state; defaults
                to an empty mapping.
            net_worth: The canned net-worth value ``net_worth`` returns; defaults to
                an empty ARS net worth when omitted.
        """
        self._committed = committed
        self._institutions = institutions if institutions is not None else {}
        self._net_worth = net_worth if net_worth is not None else _empty_net_worth()
        self.requested_user_id: str | None = None

    async def list_accounts(self, user_id: str) -> list[AccountReadModel]:
        """List the owner's accounts newest-first by creation, joining institution data (ADR-130, ADR-134)."""
        owned = [account for account in self._committed.values() if account.user_id == user_id]
        ordered = sorted(owned, key=lambda account: (account.created_at, account.id), reverse=True)
        models: list[AccountReadModel] = []
        for account in ordered:
            institution = self._institutions[account.institution_id]
            models.append(
                AccountReadModel(
                    id=account.id,
                    institution_id=account.institution_id,
                    institution_name=institution.name,
                    type=institution.type,
                    currency=account.currency,
                    opening_balance=account.opening_balance,
                )
            )
        return models

    async def net_worth(self, user_id: str) -> NetWorth:
        """Record the requested owner and return the canned net worth (ADR-108)."""
        self.requested_user_id = user_id
        return self._net_worth


class FakeInstitutionReader(AbstractInstitutionReader):
    """In-memory institution reader projecting committed institutions (ADR-130, ADR-134).

    Mirrors :class:`FakeAccountReader` for the institutions list (owner-scoped,
    newest-first by creation).
    """

    def __init__(self, committed: dict[UUID, Institution]) -> None:
        """Initialize over a committed institution store.

        Args:
            committed: The institutions to project, keyed by id. Pass a unit of
                work's ``committed_institutions`` to share state.
        """
        self._committed = committed

    async def list_institutions(self, user_id: str) -> list[InstitutionReadModel]:
        """List the owner's institutions newest-first by creation (ADR-130)."""
        owned = [institution for institution in self._committed.values() if institution.user_id == user_id]
        ordered = sorted(owned, key=lambda institution: (institution.created_at, institution.id), reverse=True)
        return [
            InstitutionReadModel(id=institution.id, name=institution.name, type=institution.type)
            for institution in ordered
        ]


class FakeTransferReader(AbstractTransferReader):
    """In-memory transfer reader projecting committed transfers (ADR-135, ADR-130).

    Mirrors :class:`FakeInstitutionReader` for the transfers list (owner-scoped,
    newest-first by ``occurred_on`` then ``created_at``).
    """

    def __init__(self, committed: dict[UUID, Transfer]) -> None:
        """Initialize over a committed transfer store.

        Args:
            committed: The transfers to project, keyed by id. Pass a unit of work's
                ``committed_transfers`` to share state.
        """
        self._committed = committed

    async def list_transfers(self, user_id: str) -> list[TransferReadModel]:
        """List the owner's transfers newest-first by occurrence then creation (ADR-130)."""
        owned = [transfer for transfer in self._committed.values() if transfer.user_id == user_id]
        ordered = sorted(owned, key=lambda transfer: (transfer.occurred_on, transfer.created_at), reverse=True)
        return [
            TransferReadModel(
                id=transfer.id,
                from_account_id=transfer.from_account_id,
                to_account_id=transfer.to_account_id,
                amount_out=transfer.amount_out,
                amount_in=transfer.amount_in,
                occurred_on=transfer.occurred_on,
                note=transfer.note,
            )
            for transfer in ordered
        ]


class FakeBudgetReader(AbstractBudgetReader):
    """Budget reader returning a canned :class:`MonthlyBudget` for route tests (ADR-125).

    The route tests assert wiring and the HTTP contract, not the target/actual join
    (covered by the pure-function and integration tiers), so this fake records the
    requested month and owner and returns the budget it was given (ADR-032, ADR-108).
    """

    def __init__(self, budget: MonthlyBudget, history: CategoryHistory | None = None) -> None:
        """Initialize the reader with the budget and history every call returns.

        Args:
            budget: The monthly budget every ``monthly_budget`` call returns.
            history: The category history every ``category_history`` call returns;
                an empty history when not provided.
        """
        self._budget = budget
        self._history = history if history is not None else CategoryHistory(categories=[])
        self.requested_month: date | None = None
        self.requested_user_id: str | None = None
        self.requested_currency: Currency | None = None

    async def monthly_budget(
        self,
        month: date,
        user_id: str,
        currency: Currency = Currency.ARS,
    ) -> MonthlyBudget:
        """Record the requested month, owner and currency and return the canned budget (ADR-108, ADR-152)."""
        self.requested_month = month
        self.requested_user_id = user_id
        self.requested_currency = currency
        return self._budget

    async def category_history(
        self,
        month: date,
        user_id: str,
        currency: Currency = Currency.ARS,
    ) -> CategoryHistory:
        """Record the requested month, owner and currency and return the canned history (ADR-108, ADR-145, ADR-152)."""
        self.requested_month = month
        self.requested_user_id = user_id
        self.requested_currency = currency
        return self._history


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


class FakeReportsReader(AbstractReportsReader):
    """Reports reader returning a canned :class:`NetWorthHistory` for route tests (ADR-164).

    The route tests assert wiring and the HTTP contract, not the cumulative SQL
    (covered by the pure-function and integration tiers), so this fake records the
    requested owner and months and returns the history it was given (ADR-032, ADR-108).
    """

    def __init__(self, history: NetWorthHistory, overview: ReportsOverview | None = None) -> None:
        """Initialize the reader with the history (and optional overview) every call returns.

        Args:
            history: The net-worth history every ``net_worth_history`` call returns.
            overview: The overview every ``overview`` call returns; required for the
                overview route tests (ADR-167) and unused by the history tests.
        """
        self._history = history
        self._overview = overview
        self.requested_user_id: str | None = None
        self.requested_months: int | None = None
        self.requested_range: str | None = None
        self.requested_currency: Currency | None = None

    async def overview(
        self,
        user_id: str,
        *,
        range_key: str,
        currency: Currency = Currency.ARS,
    ) -> ReportsOverview:
        """Record the owner, range and currency and return the canned overview (ADR-108, ADR-167)."""
        self.requested_user_id = user_id
        self.requested_range = range_key
        self.requested_currency = currency
        assert self._overview is not None  # the overview tests always seed one.
        return self._overview

    async def net_worth_history(self, user_id: str, *, months: int = 12) -> NetWorthHistory:
        """Record the requested owner and months and return the canned history (ADR-108)."""
        self.requested_user_id = user_id
        self.requested_months = months
        return self._history


class FakeForecastReader(AbstractForecastReader):
    """Forecast reader returning a canned :class:`ForecastSeries` for route tests (ADR-176).

    The route tests assert wiring and the HTTP contract, not the committed-stream SQL
    (covered by the pure-function and integration tiers), so this fake records the
    requested owner, horizon and currency and returns the series it was given (ADR-032,
    ADR-108).
    """

    def __init__(self, series: ForecastSeries) -> None:
        """Initialize the reader with the forecast series every call returns.

        Args:
            series: The forecast series every ``forecast`` call returns.
        """
        self._series = series
        self.requested_user_id: str | None = None
        self.requested_horizon: int | None = None
        self.requested_currency: Currency | None = None

    async def forecast(
        self,
        user_id: str,
        *,
        horizon: int = 6,
        currency: Currency = Currency.ARS,
    ) -> ForecastSeries:
        """Record the owner, horizon and currency and return the canned series (ADR-108, ADR-176)."""
        self.requested_user_id = user_id
        self.requested_horizon = horizon
        self.requested_currency = currency
        return self._series


class FakeCommittedReader(AbstractCommittedReader):
    """Committed-spend reader returning a canned :class:`CommittedSplit` for route tests (ADR-179).

    The route tests assert wiring and the HTTP contract, not the committed-stream SQL
    (covered by the pure-function and integration tiers), so this fake records the
    requested month, owner and currency and returns the split it was given (ADR-032,
    ADR-108).
    """

    def __init__(self, split: CommittedSplit) -> None:
        """Initialize the reader with the committed split every call returns.

        Args:
            split: The committed split every ``committed`` call returns.
        """
        self._split = split
        self.requested_month: date | None = None
        self.requested_user_id: str | None = None
        self.requested_currency: Currency | None = None

    async def committed(
        self,
        month: date,
        user_id: str,
        *,
        currency: Currency = Currency.ARS,
    ) -> CommittedSplit:
        """Record the month, owner and currency and return the canned split (ADR-108, ADR-179)."""
        self.requested_month = month
        self.requested_user_id = user_id
        self.requested_currency = currency
        return self._split


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

    def __init__(self, settings: dict[str, str | bool]) -> None:
        """Initialize over a shared settings dict."""
        self._settings = settings

    async def get_settings(self, user_id: str) -> AppSettings:
        """Project the owner's shared dict into an :class:`AppSettings`, applying defaults."""
        return AppSettings(
            preferred_display_currency=str(self._settings.get("preferred_display_currency", _DEFAULT_DISPLAY_CURRENCY)),
            fx_default_rate_type=str(self._settings.get("fx_default_rate_type", _DEFAULT_FX_RATE_TYPE)),
            preferred_rate_source=str(self._settings.get("preferred_rate_source", _DEFAULT_PREFERRED_RATE_SOURCE)),
            monotributo_current_category=str(self._settings.get("current_category", _DEFAULT_MONOTRIBUTO_CATEGORY)),
            monotributo_activity_type=str(self._settings.get("activity_type", _DEFAULT_MONOTRIBUTO_ACTIVITY_TYPE)),
            monotributo_enabled=bool(self._settings.get("monotributo_enabled", _DEFAULT_MONOTRIBUTO_ENABLED)),
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
        fx_source=transaction.fx_source,
        fx_rate_type=transaction.fx_rate_type,
        fx_rate_as_of=transaction.fx_rate_as_of,
        category=transaction.category,
        payment_method=transaction.payment_method,
        card=transaction.card,
        notes=transaction.notes,
        recurring=transaction.recurring,
        recurring_cadence=transaction.recurring_cadence,
        installments_total=transaction.installments_total,
        installments_index=transaction.installments_index,
        counts_toward_monotributo=transaction.counts_toward_monotributo,
        statement_document_id=transaction.statement_document_id,
        account_id=transaction.account_id,
        offsets_transaction_id=transaction.offsets_transaction_id,
        created_at=transaction.created_at,
        updated_at=transaction.updated_at,
    )
