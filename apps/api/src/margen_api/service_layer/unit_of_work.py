"""Transaction boundaries for application handlers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from types import TracebackType

from margen_api.domain.messages import Event


class IntegrityConflict(RuntimeError):
    """Raised when persistence rejects a conflicting write."""


class AbstractUnitOfWork(ABC):
    """Provide atomic persistence and event collection."""

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
