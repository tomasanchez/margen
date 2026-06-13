"""Mapping between the ``Transaction`` aggregate and its SQLAlchemy record.

The domain aggregate stays plain Python while the ``TransactionRecord`` holds the
relational shape (ADR-025/026/027/029). This module is the single place that
translates between the two, so the repository never reaches into ORM internals
and the domain never learns about SQLAlchemy (AGENTS.md).
"""

from __future__ import annotations

from margen_api.adapters.models.transaction import TransactionRecord
from margen_api.domain.models.transaction import Transaction
from margen_api.domain.models.value_objects import Currency, FxRateType, Kind


def to_domain(record: TransactionRecord) -> Transaction:
    """Build a domain :class:`Transaction` from a persisted record.

    The aggregate re-runs its invariants in ``__post_init__``; persisted rows are
    already valid, so this is a faithful rehydration rather than fresh validation.
    The FX block is copied verbatim (ADR-029); ARS rows simply carry ``None``.

    Args:
        record: The relational row to rehydrate.

    Returns:
        The reconstructed ``Transaction`` aggregate.
    """
    return Transaction(
        id=record.id,
        occurred_on=record.occurred_on,
        name=record.name,
        kind=Kind.parse(record.kind),
        amount=record.amount,
        currency=Currency.parse(record.currency),
        usd_amount=record.usd_amount,
        fx_rate=record.fx_rate,
        fx_rate_type=FxRateType(record.fx_rate_type) if record.fx_rate_type is not None else None,
        fx_rate_as_of=record.fx_rate_as_of,
        category=record.category,
        payment_method=record.payment_method,
        notes=record.notes,
        recurring=record.recurring,
        counts_toward_monotributo=record.counts_toward_monotributo,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def to_record(transaction: Transaction) -> TransactionRecord:
    """Build a fresh persistence record from a domain :class:`Transaction`.

    Used when adding a new aggregate. ``kind``, ``currency`` and ``fx_rate_type``
    are stored as their string values (ADR-027) since the columns are plain
    strings.

    Args:
        transaction: The aggregate to persist.

    Returns:
        A new, unattached ``TransactionRecord`` carrying every field.
    """
    record = TransactionRecord()
    update_record(record, transaction)
    return record


def update_record(record: TransactionRecord, transaction: Transaction) -> None:
    """Copy every field from a domain aggregate onto an existing record.

    Used both to build a new record and to apply changes to an attached row
    (update/persist semantics). ``id`` is set so a detached record carries its
    identity; for an attached row it is already the same value.

    Args:
        record: The relational row to update in place.
        transaction: The aggregate whose state to copy.
    """
    record.id = transaction.id
    record.occurred_on = transaction.occurred_on
    record.name = transaction.name
    record.kind = transaction.kind.value
    record.amount = transaction.amount
    record.currency = transaction.currency.value
    record.usd_amount = transaction.usd_amount
    record.fx_rate = transaction.fx_rate
    record.fx_rate_type = transaction.fx_rate_type.value if transaction.fx_rate_type is not None else None
    record.fx_rate_as_of = transaction.fx_rate_as_of
    record.category = transaction.category
    record.payment_method = transaction.payment_method
    record.notes = transaction.notes
    record.recurring = transaction.recurring
    record.counts_toward_monotributo = transaction.counts_toward_monotributo
    record.created_at = transaction.created_at
    record.updated_at = transaction.updated_at
