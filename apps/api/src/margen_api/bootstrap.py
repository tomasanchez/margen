"""Application composition root."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from margen_api.adapters.models.base import Base
from margen_api.adapters.unit_of_work import SqlAlchemyUnitOfWork
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork
from margen_api.settings.database_settings import DatabaseSettings


@dataclass
class ApplicationContainer:
    """Hold process-level application dependencies."""

    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]
    uow_factory: Callable[[], AbstractUnitOfWork]
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
    bus = MessageBus(uow_factory=uow_factory, command_handlers={}, event_handlers={})
    return ApplicationContainer(
        engine=engine,
        session_factory=session_factory,
        uow_factory=uow_factory,
        bus=bus,
        auto_create_schema=settings.AUTO_CREATE_SCHEMA,
    )
