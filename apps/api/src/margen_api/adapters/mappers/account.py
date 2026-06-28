"""Mapping between the ``Account`` aggregate and its SQLAlchemy record (ADR-122, ADR-134).

The domain aggregate stays plain Python while the ``AccountRecord`` holds the
relational shape. This module is the single place that translates between the two,
so the repository never reaches into ORM internals and the domain never learns
about SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.account import AccountRecord
from margen_api.domain.models.account import Account
from margen_api.domain.models.value_objects import Currency


def to_domain(record: AccountRecord) -> Account:
    """Build a domain :class:`Account` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are
    already valid, so this is a faithful rehydration rather than fresh validation.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Account`` aggregate.
    """
    return Account(
        id=record.id,
        institution_id=record.institution_id,
        currency=Currency.parse(record.currency),
        opening_balance=record.opening_balance,
        user_id=str(record.user_id) if record.user_id is not None else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(account: Account) -> AccountRecord:
    """Build a fresh persistence record from a domain :class:`Account`.

    Used when adding a new aggregate. ``currency`` is stored as its string value
    since the column is a plain string (ADR-027 style).

    Args:
        account: The aggregate to persist.

    Returns:
        A new, unattached ``AccountRecord`` carrying every field.
    """
    record = AccountRecord()
    update_record(record, account)
    return record


def update_record(record: AccountRecord, account: Account) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row
    (update/persist semantics). ``id`` is set so a detached record carries its
    identity; for an attached row it is already the same value.

    Args:
        record: The relational row to update in place.
        account: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write
            path threads the authenticated owner (ADR-130), so a missing id is a
            programming error rather than a persistable state.
    """
    record.id = account.id
    record.institution_id = account.institution_id
    record.currency = account.currency.value
    record.opening_balance = account.opening_balance
    if account.user_id is None:
        msg = "Cannot persist an account without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(account.user_id)
    record.created_at = account.created_at
    record.updated_at = account.updated_at
