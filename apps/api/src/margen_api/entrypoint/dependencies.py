"""Shared FastAPI dependencies for entrypoints.

Resolves the process-level application container from request state so that
entrypoint handlers depend on the composition root through dependency
injection rather than module-level globals.
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request

from margen_api.adapters.queries import SqlAlchemyTransactionReader
from margen_api.bootstrap import ApplicationContainer
from margen_api.service_layer.messagebus import MessageBus
from margen_api.service_layer.reader import AbstractTransactionReader


def get_container(request: Request) -> ApplicationContainer:
    """Return application dependencies from FastAPI state."""
    return request.app.state.container


Container = Annotated[ApplicationContainer, Depends(get_container)]


def get_bus(container: Container) -> MessageBus:
    """Return the message bus that dispatches commands to handlers."""
    return container.bus


Bus = Annotated[MessageBus, Depends(get_bus)]


async def get_transaction_reader(container: Container) -> AsyncIterator[AbstractTransactionReader]:
    """Yield a transaction reader over a request-scoped read-only session.

    Query paths bypass the unit of work by design (ADR-028); the session opened
    here is closed when the request finishes.
    """
    session = container.session_factory()
    try:
        yield SqlAlchemyTransactionReader(session)
    finally:
        await session.close()


TransactionReader = Annotated[AbstractTransactionReader, Depends(get_transaction_reader)]
