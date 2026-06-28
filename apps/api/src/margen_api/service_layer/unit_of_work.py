"""Transaction boundaries for application handlers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from types import TracebackType

from margen_api.domain.messages import Event
from margen_api.service_layer.account_repository import AbstractAccountRepository
from margen_api.service_layer.document_store import AbstractDocumentStore
from margen_api.service_layer.institution_repository import AbstractInstitutionRepository
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.repository import AbstractTransactionRepository
from margen_api.service_layer.settings_repository import AbstractSettingsRepository
from margen_api.service_layer.statement_store import AbstractStatementStore
from margen_api.service_layer.transfer_repository import AbstractTransferRepository


class IntegrityConflict(RuntimeError):
    """Raised when persistence rejects a conflicting write."""


class AbstractUnitOfWork(ABC):
    """Provide atomic persistence and event collection.

    The unit of work exposes the write-side repositories the application needs.
    Query paths use the reader port (ADR-028) and do not go through the UoW.

    Attributes:
        transactions: Repository for the ``Transaction`` aggregate, available
            inside the ``async with`` boundary.
        monotributo_snapshots: Repository for the Monotributo snapshot history,
            written by the read-records capture handler (ADR-052).
        settings: Repository for the single-row application settings, written by
            the update-settings handler (ADR-054).
        documents: Storage port for the original invoice PDF and its import
            metadata, written by the create-with-attachment handler (ADR-071).
        statements: Storage port for the original statement PDF and its import
            metadata, written by the import-statement handler (ADR-077, ADR-078).
        accounts: Repository for the ``Account`` aggregate, written by the
            account create/update handlers and read by the transaction handlers'
            ownership check (ADR-122, ADR-130).
        institutions: Repository for the ``Institution`` aggregate, written by the
            institution create/update handlers and read by the account handlers'
            ownership check (ADR-130, ADR-134).
        transfers: Repository for the ``Transfer`` aggregate, written by the
            transfer create/delete handlers (ADR-135). A transfer create also stages
            its fee expense transactions through ``transactions`` in the same unit
            of work (ADR-135).
    """

    transactions: AbstractTransactionRepository
    monotributo_snapshots: AbstractMonotributoSnapshotRepository
    settings: AbstractSettingsRepository
    documents: AbstractDocumentStore
    statements: AbstractStatementStore
    accounts: AbstractAccountRepository
    institutions: AbstractInstitutionRepository
    transfers: AbstractTransferRepository

    async def __aenter__(self) -> AbstractUnitOfWork:
        """Enter the transaction boundary."""
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Roll back work that did not explicitly commit."""
        await self.rollback()

    @abstractmethod
    async def commit(self) -> None:
        """Commit the current transaction."""

    @abstractmethod
    async def flush(self) -> None:
        """Flush staged changes within the transaction without committing.

        Used to materialize a parent row before a dependent side record is added
        in the same unit of work (e.g. a transaction before its invoice document,
        so the foreign key resolves — ADR-070/071).
        """

    @abstractmethod
    async def rollback(self) -> None:
        """Roll back the current transaction."""

    def collect_new_events(self) -> Iterator[Event]:
        """Yield pending events from aggregates seen in this transaction.

        Without the example aggregate slice this monitor-only baseline tracks no
        aggregates, so the iterator yields nothing.
        """
        return
        yield  # pragma: no cover - unreachable generator sentinel
