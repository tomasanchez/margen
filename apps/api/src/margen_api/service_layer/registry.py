"""Command and event handler registries for the message bus (ADR-028).

The composition root reads these maps to build the :class:`MessageBus`. Keeping
the wiring here (rather than inline in ``bootstrap``) means new aggregates
register their handlers in one obvious place. No domain events exist yet
(ADR-028), so the event registry is empty.
"""

from __future__ import annotations

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.commands.monotributo import CaptureMonotributoSnapshot
from margen_api.domain.commands.settings import UpdateSettings
from margen_api.domain.commands.statement import ImportStatement
from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.service_layer.account_handlers import create_account, update_account
from margen_api.service_layer.handlers import (
    create_transaction,
    delete_transaction,
    import_statement,
    update_transaction,
)
from margen_api.service_layer.messagebus import CommandHandler, EventHandler
from margen_api.service_layer.monotributo_handlers import capture_monotributo_snapshot
from margen_api.service_layer.settings_handlers import update_settings

COMMAND_HANDLERS: dict[type, CommandHandler] = {
    CreateTransaction: create_transaction,
    UpdateTransaction: update_transaction,
    DeleteTransaction: delete_transaction,
    ImportStatement: import_statement,
    CaptureMonotributoSnapshot: capture_monotributo_snapshot,
    UpdateSettings: update_settings,
    CreateAccount: create_account,
    UpdateAccount: update_account,
}

EVENT_HANDLERS: dict[type, list[EventHandler]] = {}
