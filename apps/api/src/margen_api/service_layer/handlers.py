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

from margen_api.domain.commands.statement import (
    ImportStatement,
    StatementDocumentPayload,
    StatementImportResult,
)
from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    TransactionDocumentPayload,
    UpdateTransaction,
)
from margen_api.domain.models.exceptions import TransactionNotFoundError
from margen_api.domain.models.transaction import Transaction, build_transaction
from margen_api.domain.models.value_objects import Kind
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
    (ADR-031). When the command carries an optional invoice ``document``, the PDF
    and its import metadata are saved as a 1:1 side record through the
    ``DocumentStore`` port in the same unit of work, before the single commit
    (ADR-070, ADR-071); the bytes are a side record and never enter the aggregate.

    Args:
        command: The validated create request.
        uow: The unit of work providing the transaction repository and the
            invoice document store.

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
        if command.document is not None:
            # Flush the transaction first so the document's foreign key resolves;
            # SQLAlchemy does not order these two inserts on its own (ADR-070/071).
            await uow.flush()
            await _save_invoice_document(uow, transaction.id, command.document)
        await uow.commit()
    return transaction.id


async def _save_invoice_document(
    uow: AbstractUnitOfWork,
    transaction_id: UUID,
    document: TransactionDocumentPayload,
) -> None:
    """Stage the imported invoice PDF as a 1:1 side record (ADR-070, ADR-071).

    Persists through the ``DocumentStore`` port on the same unit of work as the
    transaction so both land in one commit. The document is a side record, not
    part of the transaction aggregate, so its bytes stay out of the domain model.

    Args:
        uow: The unit of work whose document store stages the row.
        transaction_id: The just-built transaction the document belongs to.
        document: The validated document payload carrying the PDF and metadata.
    """
    await uow.documents.save(
        transaction_id=transaction_id,
        pdf_bytes=document.pdf_bytes,
        content_type=document.content_type,
        byte_size=document.byte_size,
        extracted_text=document.extracted_text,
        qr_json=document.qr_json,
        emisor_cuit=document.emisor_cuit,
        pto_vta=document.pto_vta,
        tipo_cmp=document.tipo_cmp,
        nro_cmp=document.nro_cmp,
        cae=document.cae,
        fecha=document.fecha,
        importe=document.importe,
        moneda=document.moneda,
        ctz=document.ctz,
    )


async def import_statement(command: ImportStatement, uow: AbstractUnitOfWork) -> StatementImportResult:
    """Import a confirmed credit-card statement as EXPENSE transactions (ADR-078).

    Within a single unit of work (ADR-078): saves the statement ``document`` once
    through the ``StatementStore`` port (which flushes and returns the new id),
    then builds one EXPENSE transaction per confirmed line — each linked to the
    document via ``statement_document_id`` — through the domain factory so
    invariants run (ADR-031), and commits atomically. The handler injects each
    transaction's UUID identity and ``created_at``/``updated_at`` timestamps so the
    domain stays clock- and UUID-free (ADR-026). Every imported line is an EXPENSE
    that never counts toward Monotributo (ADR-079).

    Args:
        command: The validated import request carrying the document and lines.
        uow: The unit of work providing the statement store and the transaction
            repository.

    Returns:
        The :class:`StatementImportResult` with the shared statement document id and
        the created transaction ids, in line order.
    """
    now = datetime.now(UTC)
    async with uow:
        document_id = await _save_statement_document(uow, command.document)
        created: list[UUID] = []
        for line in command.lines:
            transaction = build_transaction(
                transaction_id=uuid4(),
                created_at=now,
                updated_at=now,
                occurred_on=line.occurred_on,
                name=line.name,
                kind=Kind.EXPENSE,
                amount=line.amount,
                currency=line.currency,
                usd_amount=line.usd_amount,
                fx_rate=line.fx_rate,
                fx_rate_type=line.fx_rate_type,
                fx_rate_as_of=line.fx_rate_as_of,
                category=line.category,
                payment_method=line.payment_method,
                notes=line.notes,
                statement_document_id=document_id,
            )
            uow.transactions.add(transaction)
            created.append(transaction.id)
        await uow.commit()
    return StatementImportResult(statement_document_id=document_id, transaction_ids=created)


async def _save_statement_document(
    uow: AbstractUnitOfWork,
    document: StatementDocumentPayload,
) -> UUID:
    """Stage the statement PDF as the shared parent row and return its id (ADR-077).

    Persists through the ``StatementStore`` port on the unit of work; the store
    flushes so the generated id is available to link every imported transaction in
    the same unit of work (ADR-078). The document is a parent record, not part of a
    transaction aggregate, so its bytes stay out of the domain model.

    Args:
        uow: The unit of work whose statement store stages the row.
        document: The validated document payload carrying the PDF and metadata.

    Returns:
        The new statement document identity.
    """
    return await uow.statements.save(
        pdf_bytes=document.pdf_bytes,
        content_type=document.content_type,
        byte_size=document.byte_size,
        extracted_text=document.extracted_text,
        bank_name=document.bank_name,
        network=document.network,
        card_last4=document.card_last4,
        issuer_cuit=document.issuer_cuit,
        statement_number=document.statement_number,
        period_close=document.period_close,
        period_due=document.period_due,
        total_amount=document.total_amount,
    )


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
