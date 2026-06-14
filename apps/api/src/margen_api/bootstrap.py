"""Application composition root."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from margen_api.adapters.models.base import Base
from margen_api.adapters.queries import SqlAlchemySummaryReader, SqlAlchemyTransactionReader
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.reader import AbstractTransactionReader
from margen_api.service_layer.registry import COMMAND_HANDLERS, EVENT_HANDLERS
from margen_api.service_layer.summary_reader import AbstractSummaryReader
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork
from margen_api.settings.database_settings import DatabaseSettings


@dataclass
class ApplicationContainer:
    """Hold process-level application dependencies.

    Attributes:
        engine: The shared async SQLAlchemy engine.
        session_factory: Factory producing the engine's async sessions.
        uow_factory: Factory producing a unit of work for write paths.
        reader_factory: Factory producing a transaction reader for query paths
            (ADR-028). Each call opens a fresh read-only session so the router
            can resolve a reader per request without going through the UoW.
        summary_reader_factory: Factory producing a monthly-summary reader for
            the query-only summaries path (ADR-042), with the same per-call
            read-only session ownership as ``reader_factory``.
        bus: The message bus that dispatches commands to handlers.
        auto_create_schema: Whether startup creates tables (demos/tests only).
    """

    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]
    uow_factory: Callable[[], AbstractUnitOfWork]
    reader_factory: Callable[[], AbstractTransactionReader]
    summary_reader_factory: Callable[[], AbstractSummaryReader]
    bus: MessageBus
    auto_create_schema: bool

    async def startup(self) -> None:
        """Initialize resources required by the running application."""
        if self.auto_create_schema:
            async with self.engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)

    async def shutdown(self) -> None:
        """Release process-level resources."""
        await self.engine.dispose()


def bootstrap(
    database_settings: DatabaseSettings | None = None,
) -> ApplicationContainer:
    """Build application dependencies.

    Args:
        database_settings: Optional database configuration override.

    Returns:
        A configured application container.
    """
    settings = database_settings or DatabaseSettings()
    engine_options = {}
    url = make_url(settings.URL)
    if url.get_backend_name() == "sqlite" and url.database in (None, "", ":memory:"):
        # An in-memory SQLite database lives inside one connection. Share a
        # single static-pooled connection so the schema and data created at
        # startup remain visible to every unit of work.
        engine_options = {"connect_args": {"check_same_thread": False}, "poolclass": StaticPool}
    engine = create_async_engine(settings.URL, **engine_options)
    session_factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)
    uow_factory = partial(SqlAlchemyUnitOfWork, session_factory)

    def reader_factory() -> SqlAlchemyTransactionReader:
        """Build a reader over a fresh read-only session.

        The caller owns the returned reader's ``session`` and is responsible for
        closing it (the router does so via its FastAPI dependency). Query paths
        bypass the unit of work by design (ADR-028).
        """
        return SqlAlchemyTransactionReader(session_factory())

    def summary_reader_factory() -> SqlAlchemySummaryReader:
        """Build a summary reader over a fresh read-only session (ADR-042).

        The caller owns the returned reader's ``session`` and closes it (the
        router does so via its FastAPI dependency). Query paths bypass the unit
        of work by design (ADR-028).
        """
        return SqlAlchemySummaryReader(session_factory())

    bus = MessageBus(
        uow_factory=uow_factory,
        command_handlers=dict(COMMAND_HANDLERS),
        event_handlers={event: list(handlers) for event, handlers in EVENT_HANDLERS.items()},
    )
    return ApplicationContainer(
        engine=engine,
        session_factory=session_factory,
        uow_factory=uow_factory,
        reader_factory=reader_factory,
        summary_reader_factory=summary_reader_factory,
        bus=bus,
        auto_create_schema=settings.AUTO_CREATE_SCHEMA,
    )
