"""Application handlers for the account aggregate (ADR-122, ADR-130).

One thin handler per command. Handlers orchestrate the use case — they generate
server-managed identity and timestamps (ADR-026), build the aggregate through the
domain so invariants run (ADR-031), and drive persistence through the unit of work
(``async with uow: ... await uow.commit()``). Business rules live in the domain;
handlers contain no SQLAlchemy and no validation of their own (AGENTS.md). Every
write is owner-scoped (ADR-130).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from margen_api.domain.commands.account import CreateAccount, UpdateAccount
from margen_api.domain.models.account import Account, build_account
from margen_api.domain.models.exceptions import AccountNotFoundError
from margen_api.service_layer.unit_of_work import AbstractUnitOfWork

# Mutable fields a patch may carry; ``None`` in the command means "leave
# unchanged" (ADR-028). Identity, ownership and ``created_at`` are never patched.
_PATCHABLE_FIELDS = ("name", "type", "currency", "opening_balance")


async def create_account(command: CreateAccount, uow: AbstractUnitOfWork) -> UUID:
    """Create a new account owned by the caller and return its identity (ADR-122, ADR-130).

    The handler injects the UUID identity and ``created_at``/``updated_at``
    timestamps so the domain stays clock- and UUID-free in production (ADR-026),
    then builds the aggregate through the domain factory so invariants run
    (ADR-031). The account is stamped with ``command.user_id`` so it is owned from
    creation (ADR-130).

    Args:
        command: The validated create request.
        uow: The unit of work providing the account repository.

    Returns:
        The UUID identity of the newly persisted account.
    """
    now = datetime.now(UTC)
    account = build_account(
        account_id=uuid4(),
        created_at=now,
        updated_at=now,
        name=command.name,
        type=command.type,
        currency=command.currency,
        opening_balance=command.opening_balance,
        user_id=command.user_id,
    )
    async with uow:
        uow.accounts.add(account)
        await uow.commit()
    return account.id


async def update_account(command: UpdateAccount, uow: AbstractUnitOfWork) -> UUID:
    """Apply a partial patch to one of the caller's accounts (ADR-122, ADR-130).

    Loads the aggregate by identity scoped to ``user_id`` (a foreign owner's id is
    not found, ADR-111), overlays the present fields (``None`` leaves a field
    unchanged), rebuilds it through the domain so invariants re-run (ADR-031),
    preserves ``id``, ``created_at`` and ownership, and refreshes ``updated_at``.

    Args:
        command: The validated patch request, addressing one aggregate by ``id``.
        uow: The unit of work providing the account repository.

    Returns:
        The UUID identity of the updated account.

    Raises:
        AccountNotFoundError: When no account matches ``command.id`` for the owner.
    """
    async with uow:
        existing = await uow.accounts.get(command.id, command.user_id)
        if existing is None:
            raise AccountNotFoundError(command.id)
        patched = _apply_patch(existing, command)
        await uow.accounts.persist(patched)
        await uow.commit()
    return patched.id


def _apply_patch(existing: Account, command: UpdateAccount) -> Account:
    """Build a new aggregate overlaying the patch's present fields (ADR-122).

    Rebuilding through :func:`build_account` re-runs the domain invariants so the
    patched state is validated and normalized, while preserving identity,
    ``created_at`` and ownership (``user_id``) and bumping ``updated_at`` to now
    (ADR-026, ADR-031, ADR-130). Ownership is never patchable.
    """
    fields = {name: getattr(existing, name) for name in _PATCHABLE_FIELDS}
    for name in _PATCHABLE_FIELDS:
        value = getattr(command, name)
        if value is not None:
            fields[name] = value
    return build_account(
        account_id=existing.id,
        created_at=existing.created_at,
        updated_at=datetime.now(UTC),
        user_id=existing.user_id,
        **fields,
    )
