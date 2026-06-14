"""SQLAlchemy transaction adapter."""

from __future__ import annotations

from types import TracebackType

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from margen_api.adapters.monotributo_repository import SqlAlchemyMonotributoSnapshotRepository
from margen_api.adapters.repository import SqlAlchemyTransactionRepository
from margen_api.adapters.settings_repository import SqlAlchemySettingsRepository
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork, IntegrityConflict


class SqlAlchemyUnitOfWork(AbstractUnitOfWork):
    """Manage a SQLAlchemy session as one atomic unit."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]):
        """Initialize the unit of work.

        Args:
            session_factory: Factory used to create an async SQLAlchemy session.
        """
        self.session_factory = session_factory

    async def __aenter__(self) -> SqlAlchemyUnitOfWork:
        """Open a session and repositories."""
        self.session = self.session_factory()
        self.transactions = SqlAlchemyTransactionRepository(self.session)
        self.monotributo_snapshots = SqlAlchemyMonotributoSnapshotRepository(self.session)
        self.settings = SqlAlchemySettingsRepository(self.session)
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Roll back unfinished work and close the session."""
        await super().__aexit__(exception_type, exception, traceback)
        await self.session.close()

    async def commit(self) -> None:
        """Persist tracked aggregate changes and commit the transaction."""
        try:
            await self.session.commit()
        except IntegrityError as error:
            raise IntegrityConflict from error

    async def rollback(self) -> None:
        """Roll back the SQLAlchemy transaction."""
        await self.session.rollback()
