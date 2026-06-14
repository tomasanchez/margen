"""Command and event handler registries for the message bus (ADR-028).

The composition root reads these maps to build the :class:`MessageBus`. Keeping
the wiring here (rather than inline in ``bootstrap``) means new aggregates
register their handlers in one obvious place. No domain events exist yet
(ADR-028), so the event registry is empty.
"""

from __future__ import annotations

from margen_api.domain.commands.monotributo import (
    CaptureMonotributoSnapshot,
    UpdateMonotributoConfig,
)
from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.service_layer.handlers import (
    create_transaction,
    delete_transaction,
    update_transaction,
)
from margen_api.service_layer.messagebus import CommandHandler, EventHandler
from margen_api.service_layer.monotributo_handlers import (
    capture_monotributo_snapshot,
    update_monotributo_config,
)

COMMAND_HANDLERS: dict[type, CommandHandler] = {
    CreateTransaction: create_transaction,
    UpdateTransaction: update_transaction,
    DeleteTransaction: delete_transaction,
    CaptureMonotributoSnapshot: capture_monotributo_snapshot,
    UpdateMonotributoConfig: update_monotributo_config,
}

EVENT_HANDLERS: dict[type, list[EventHandler]] = {}
