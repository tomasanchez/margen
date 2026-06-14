"""Application handlers for the transaction aggregate (ADR-028).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of
work (``async with uow: ... await uow.commit()``). Business rules live in the
domain; handlers contain no SQLAlchemy and no validation of their own (AGENTS.md).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    UpdateTransaction,
)
from margen_api.domain.models.exceptions import TransactionNotFoundError
from margen_api.domain.models.transaction import Transaction, build_transaction
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Mutable fields a patch may carry; ``None`` in the command means "leave
# unchanged" (ADR-028). Identity and ``created_at`` are never patched.
_PATCHABLE_FIELDS = (
    "occurred_on",
    "name",
    "kind",
    "amount",
    "currency",
    "usd_amount",
    "fx_rate",
    "fx_rate_type",
    "fx_rate_as_of",
    "category",
    "payment_method",
    "notes",
    "recurring",
    "counts_toward_monotributo",
)


async def create_transaction(command: CreateTransaction, uow: AbstractUnitOfWork) -> UUID:
    """Record a new transaction and return its generated identity.

    The handler injects the UUID identity and ``created_at``/``updated_at``
    timestamps so the domain stays clock- and UUID-free in production (ADR-026),
    then builds the aggregate through the domain factory so invariants run
    (ADR-031).

    Args:
        command: The validated create request.
        uow: The unit of work providing the transaction repository.

    Returns:
        The UUID identity of the newly persisted transaction.
    """
    now = datetime.now(UTC)
    transaction = build_transaction(
        transaction_id=uuid4(),
        created_at=now,
        updated_at=now,
        occurred_on=command.occurred_on,
        name=command.name,
        kind=command.kind,
        amount=command.amount,
        currency=command.currency,
        usd_amount=command.usd_amount,
        fx_rate=command.fx_rate,
        fx_rate_type=command.fx_rate_type,
        fx_rate_as_of=command.fx_rate_as_of,
        category=command.category,
        payment_method=command.payment_method,
        notes=command.notes,
        recurring=command.recurring,
        counts_toward_monotributo=command.counts_toward_monotributo,
    )
    async with uow:
        uow.transactions.add(transaction)
        await uow.commit()
    return transaction.id


async def update_transaction(command: UpdateTransaction, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to an existing transaction.

    Loads the aggregate by identity, overlays the present fields (``None`` leaves
    a field unchanged), rebuilds it through the domain so invariants re-run
    (ADR-031), preserves ``id`` and ``created_at``, and refreshes ``updated_at``
    (ADR-026).

    Args:
        command: The validated patch request, addressing one aggregate by ``id``.
        uow: The unit of work providing the transaction repository.

    Returns:
        The UUID identity of the updated transaction.

    Raises:
        TransactionNotFoundError: When no transaction matches ``command.id``.
    """
    async with uow:
        existing = await uow.transactions.get(command.id)
        if existing is None:
            raise TransactionNotFoundError(command.id)
        patched = _apply_patch(existing, command)
        await uow.transactions.persist(patched)
        await uow.commit()
    return patched.id


async def delete_transaction(command: DeleteTransaction, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a transaction by identity (ADR-030).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the transaction repository.

    Raises:
        TransactionNotFoundError: When no transaction matches ``command.id``.
    """
    async with uow:
        removed = await uow.transactions.delete(command.id)
        if not removed:
            raise TransactionNotFoundError(command.id)
        await uow.commit()


def _apply_patch(existing: Transaction, command: UpdateTransaction) -> Transaction:
    """Build a new aggregate overlaying the patch's present fields.

    Rebuilding through :func:`build_transaction` re-runs the domain invariants
    so the patched state is validated and normalized, while preserving identity
    and ``created_at`` and bumping ``updated_at`` to now (ADR-026, ADR-031).
    """
    fields = {name: getattr(existing, name) for name in _PATCHABLE_FIELDS}
    for name in _PATCHABLE_FIELDS:
        value = getattr(command, name)
        if value is not None:
            fields[name] = value
    return build_transaction(
        transaction_id=existing.id,
        created_at=existing.created_at,
        updated_at=datetime.now(UTC),
        **fields,
    )
