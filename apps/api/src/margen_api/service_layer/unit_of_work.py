"""Transaction boundaries for application handlers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from types import TracebackType

from margen_api.domain.messages import Event
from margen_api.service_layer.monotributo_config_repository import (
    AbstractMonotributoConfigRepository,
)
from margen_api.service_layer.monotributo_repository import AbstractMonotributoSnapshotRepository
from margen_api.service_layer.repository import AbstractTransactionRepository


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
        monotributo_config: Repository for the single-row Monotributo config,
            written by the update-config handler (ADR-048).
    """

    transactions: AbstractTransactionRepository
    monotributo_snapshots: AbstractMonotributoSnapshotRepository
    monotributo_config: AbstractMonotributoConfigRepository

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
    async def rollback(self) -> None:
        """Roll back the current transaction."""

    def collect_new_events(self) -> Iterator[Event]:
        """Yield pending events from aggregates seen in this transaction.

        Without the example aggregate slice this monitor-only baseline tracks no
        aggregates, so the iterator yields nothing.
        """
        return
        yield  # pragma: no cover - unreachable generator sentinel
