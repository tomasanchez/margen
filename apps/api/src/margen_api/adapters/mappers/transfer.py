"""Mapping between the ``Transfer`` aggregate and its SQLAlchemy record (ADR-135).

The domain aggregate stays plain Python while the ``TransferRecord`` holds the
relational shape. This module is the single place that translates between the two,
so the repository never reaches into ORM internals and the domain never learns
about SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from uuid import UUID

from margen_api.adapters.models.transfer import TransferRecord
from margen_api.domain.models.transfer import Transfer


def to_domain(record: TransferRecord) -> Transfer:
    """Build a domain :class:`Transfer` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are
    already valid, so this is a faithful rehydration rather than fresh validation.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Transfer`` aggregate.
    """
    return Transfer(
        id=record.id,
        from_account_id=record.from_account_id,
        to_account_id=record.to_account_id,
        amount_out=record.amount_out,
        amount_in=record.amount_in,
        occurred_on=record.occurred_on,
        note=record.note,
        user_id=str(record.user_id) if record.user_id is not None else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(transfer: Transfer) -> TransferRecord:
    """Build a fresh persistence record from a domain :class:`Transfer`.

    Used when adding a new aggregate.

    Args:
        transfer: The aggregate to persist.

    Returns:
        A new, unattached ``TransferRecord`` carrying every field.
    """
    record = TransferRecord()
    update_record(record, transfer)
    return record


def update_record(record: TransferRecord, transfer: Transfer) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row. ``id``
    is set so a detached record carries its identity; for an attached row it is
    already the same value.

    Args:
        record: The relational row to update in place.
        transfer: The aggregate whose state to copy.

    Raises:
        ValueError: When the aggregate carries no owning ``user_id`` — every write
            path threads the authenticated owner (ADR-130), so a missing id is a
            programming error rather than a persistable state.
    """
    record.id = transfer.id
    record.from_account_id = transfer.from_account_id
    record.to_account_id = transfer.to_account_id
    record.amount_out = transfer.amount_out
    record.amount_in = transfer.amount_in
    record.occurred_on = transfer.occurred_on
    record.note = transfer.note
    if transfer.user_id is None:
        msg = "Cannot persist a transfer without an owning user_id (ADR-130)."
        raise ValueError(msg)
    record.user_id = UUID(transfer.user_id)
    record.created_at = transfer.created_at
    record.updated_at = transfer.updated_at
