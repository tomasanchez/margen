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
    StatementLineInput,
    StatementLineResolution,
)
from margen_api.domain.commands.transaction import (
    CreateTransaction,
    DeleteTransaction,
    SetTransactionFxSnapshot,
    TransactionDocumentPayload,
    UpdateTransaction,
)
from margen_api.domain.models.exceptions import (
    AccountNotFoundError,
    MergeTargetNotFoundError,
    TransactionNotFoundError,
)
from margen_api.domain.models.transaction import (
    Transaction,
    build_transaction,
    materialize_usd_amount,
)
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
    "fx_source",
    "fx_rate_type",
    "fx_rate_as_of",
    "category",
    "payment_method",
    "notes",
    "recurring",
    "counts_toward_monotributo",
    "account_id",
)


async def _check_account_ownership(uow: AbstractUnitOfWork, account_id: UUID | None, user_id: str) -> None:
    """Verify a linked ``account_id`` is one the caller owns (ADR-130).

    A transaction may only be attached to an account the authenticated user owns.
    When ``account_id`` is ``None`` there is nothing to link, so the check is a
    no-op. Otherwise the account repository confirms ownership; a missing account or
    one owned by another user raises :class:`AccountNotFoundError`, which the
    boundary maps to 404 (ADR-111).

    Args:
        uow: The unit of work providing the account repository (inside its boundary).
        account_id: The account being linked, or ``None`` when none.
        user_id: The authenticated owner the account must belong to.

    Raises:
        AccountNotFoundError: When ``account_id`` is not an account owned by the user.
    """
    if account_id is None:
        return
    if not await uow.accounts.owns(account_id, user_id):
        raise AccountNotFoundError(account_id)


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
        fx_source=command.fx_source,
        fx_rate_type=command.fx_rate_type,
        fx_rate_as_of=command.fx_rate_as_of,
        category=command.category,
        payment_method=command.payment_method,
        card=command.card,
        notes=command.notes,
        recurring=command.recurring,
        counts_toward_monotributo=command.counts_toward_monotributo,
        account_id=command.account_id,
        user_id=command.user_id,
    )
    async with uow:
        await _check_account_ownership(uow, command.account_id, command.user_id)
        uow.transactions.add(transaction)
        if command.document is not None:
            # Flush the transaction first so the document's foreign key resolves;
            # SQLAlchemy does not order these two inserts on its own (ADR-070/071).
            await uow.flush()
            await _save_invoice_document(uow, transaction.id, transaction.user_id, command.document)
        await uow.commit()
    return transaction.id


async def _save_invoice_document(
    uow: AbstractUnitOfWork,
    transaction_id: UUID,
    user_id: str | None,
    document: TransactionDocumentPayload,
) -> None:
    """Stage the imported invoice PDF as a 1:1 side record (ADR-070, ADR-071, ADR-108).

    Persists through the ``DocumentStore`` port on the same unit of work as the
    transaction so both land in one commit. The document is a side record, not
    part of the transaction aggregate, so its bytes stay out of the domain model.
    It is stamped with the transaction's ``user_id`` so the stored PDF is owned
    exactly like its transaction and the download is owner-scoped (ADR-108, ADR-111).

    Args:
        uow: The unit of work whose document store stages the row.
        transaction_id: The just-built transaction the document belongs to.
        user_id: The transaction's owner, copied onto the document so the bytes are
            owner-scoped on download (ADR-108).
        document: The validated document payload carrying the PDF and metadata.
    """
    await uow.documents.save(
        transaction_id=transaction_id,
        user_id=user_id,
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
    """Import a confirmed credit-card statement, resolving each line (ADR-078, ADR-085).

    Within a single unit of work (ADR-078): saves the statement ``document`` once
    through the ``StatementStore`` port (which flushes and returns the new id), then
    resolves each confirmed line per its ``resolution`` (ADR-085) and commits
    atomically:

    * ``IMPORT`` / ``KEEP_BOTH`` — build a new EXPENSE transaction linked to the
      document via ``statement_document_id`` through the domain factory so invariants
      run (ADR-031). The handler injects each transaction's UUID identity and
      ``created_at``/``updated_at`` timestamps so the domain stays clock- and
      UUID-free (ADR-026). Every created line is an EXPENSE that never counts toward
      Monotributo (ADR-079).
    * ``MERGE`` — load the existing transaction named by ``match_transaction_id`` and
      enrich it in place (ADR-085), preserving the user's manual entry; no new row is
      created.

    Args:
        command: The validated import request carrying the document and lines.
        uow: The unit of work providing the statement store and the transaction
            repository.

    Returns:
        The :class:`StatementImportResult` with the shared statement document id, the
        created transaction ids, and the merged transaction ids — each in line order.

    Raises:
        MergeTargetNotFoundError: When a ``MERGE`` line's ``match_transaction_id``
            matches no stored transaction (ADR-085).
    """
    now = datetime.now(UTC)
    async with uow:
        document_id = await _save_statement_document(uow, command.document, command.user_id)
        created: list[UUID] = []
        merged: list[UUID] = []
        for line in command.lines:
            if line.resolution is StatementLineResolution.MERGE:
                merged.append(await _merge_statement_line(uow, line, document_id, now, command.user_id))
            else:
                created.append(_create_statement_line(uow, line, document_id, now, command.user_id))
        await uow.commit()
    return StatementImportResult(
        statement_document_id=document_id,
        created_transaction_ids=created,
        merged_transaction_ids=merged,
    )


def _create_statement_line(
    uow: AbstractUnitOfWork,
    line: StatementLineInput,
    document_id: UUID,
    now: datetime,
    user_id: str,
) -> UUID:
    """Build and stage a new EXPENSE transaction for an ``IMPORT``/``KEEP_BOTH`` line.

    Builds the aggregate through the domain factory so invariants run (ADR-031),
    injecting a generated identity and the shared ``now`` timestamps (ADR-026), and
    links it to the saved statement document. The aggregate is stamped with
    ``user_id`` so an imported row is owned exactly like a manual one (ADR-108).

    Args:
        uow: The unit of work whose repository stages the new aggregate.
        line: The confirmed import line to create.
        document_id: The saved statement document the new expense links to.
        now: The shared creation/update timestamp for the import batch.
        user_id: The authenticated owner the new expense belongs to (ADR-108).

    Returns:
        The generated identity of the staged transaction.
    """
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
        fx_source=line.fx_source,
        fx_rate_type=line.fx_rate_type,
        fx_rate_as_of=line.fx_rate_as_of,
        category=line.category,
        payment_method=line.payment_method,
        card=line.card,
        notes=line.notes,
        statement_document_id=document_id,
        user_id=user_id,
    )
    uow.transactions.add(transaction)
    return transaction.id


async def _merge_statement_line(
    uow: AbstractUnitOfWork,
    line: StatementLineInput,
    document_id: UUID,
    now: datetime,
    user_id: str,
) -> UUID:
    """Enrich an existing manual expense from a ``MERGE`` line in place (ADR-085).

    The user's manual entry is the source of truth, so ``name``, ``amount``,
    ``occurred_on``, ``currency`` and any existing ``notes`` are preserved. The merge
    only adds statement-derived facts: it links the statement document, sets the
    statement bank as ``payment_method`` and the statement card detail as ``card``
    (ADR-117), fills ``category`` ONLY when the existing one is empty, and writes the
    line's cuota-derived ``notes`` ONLY when the existing notes are empty. The aggregate is rebuilt through the domain so invariants re-run
    while ``id`` and ``created_at`` are preserved and ``updated_at`` is refreshed
    (ADR-026, ADR-031), then persisted.

    Args:
        uow: The unit of work providing the transaction repository.
        line: The confirmed ``MERGE`` line carrying the statement-derived enrichment.
        document_id: The saved statement document to link the enriched expense to.
        now: The shared timestamp the enriched aggregate's ``updated_at`` takes.
        user_id: The authenticated owner; the merge target is loaded scoped to it,
            so another user's transaction is never enriched (ADR-108, ADR-111).

    Returns:
        The identity of the enriched transaction.

    Raises:
        MergeTargetNotFoundError: When ``line.match_transaction_id`` matches no row
            owned by ``user_id``.
    """
    match_id = line.match_transaction_id
    existing = await uow.transactions.get(match_id, user_id) if match_id is not None else None
    if existing is None:
        raise MergeTargetNotFoundError(match_id)

    enriched = build_transaction(
        transaction_id=existing.id,
        created_at=existing.created_at,
        updated_at=now,
        occurred_on=existing.occurred_on,
        name=existing.name,
        kind=existing.kind,
        amount=existing.amount,
        currency=existing.currency,
        usd_amount=existing.usd_amount,
        fx_rate=existing.fx_rate,
        fx_source=existing.fx_source,
        fx_rate_type=existing.fx_rate_type,
        fx_rate_as_of=existing.fx_rate_as_of,
        category=existing.category if existing.category else line.category,
        payment_method=line.payment_method,
        card=line.card,
        notes=existing.notes if existing.notes else line.notes,
        recurring=existing.recurring,
        counts_toward_monotributo=existing.counts_toward_monotributo,
        statement_document_id=document_id,
        user_id=existing.user_id,
    )
    await uow.transactions.persist(enriched)
    return enriched.id


async def _save_statement_document(
    uow: AbstractUnitOfWork,
    document: StatementDocumentPayload,
    user_id: str | None,
) -> UUID:
    """Stage the statement PDF as the shared parent row and return its id (ADR-077, ADR-108).

    Persists through the ``StatementStore`` port on the unit of work; the store
    flushes so the generated id is available to link every imported transaction in
    the same unit of work (ADR-078). The document is a parent record, not part of a
    transaction aggregate, so its bytes stay out of the domain model. It is stamped
    with the importing user's ``user_id`` so the stored PDF is owned exactly like the
    expenses it backs and the download is owner-scoped (ADR-108, ADR-111).

    Args:
        uow: The unit of work whose statement store stages the row.
        document: The validated document payload carrying the PDF and metadata.
        user_id: The importing owner, copied onto the document so the bytes are
            owner-scoped on download (ADR-108).

    Returns:
        The new statement document identity.
    """
    return await uow.statements.save(
        user_id=user_id,
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
        existing = await uow.transactions.get(command.id, command.user_id)
        if existing is None:
            raise TransactionNotFoundError(command.id)
        patched = _apply_patch(existing, command)
        # When the patch (re)links an account, confirm the caller owns it (ADR-130).
        if command.account_id is not None:
            await _check_account_ownership(uow, command.account_id, command.user_id)
        await uow.transactions.persist(patched)
        await uow.commit()
    return patched.id


async def set_transaction_fx_snapshot(command: SetTransactionFxSnapshot, uow: AbstractUnitOfWork) -> UUID:
    """Set or replace the FX snapshot on an existing transaction (ADR-148, ADR-149).

    Loads the aggregate by identity scoped to the owner, overlays the client-supplied
    ``fx_rate`` / ``fx_source``, and rebuilds it through the domain so ``usd_amount``
    is re-materialized as pure arithmetic (``round(amount ÷ fx_rate, 2)``) — no FX feed
    is ever called (ADR-149). Identity, ``created_at`` and ownership are preserved;
    ``updated_at`` is refreshed (ADR-026). Powers the client import rate-fill and the
    one-time historical backfill (ADR-149/150).

    Args:
        command: The validated snapshot request, addressing one aggregate by ``id``
            and carrying the owner ``user_id`` (ADR-108).
        uow: The unit of work providing the transaction repository.

    Returns:
        The UUID identity of the snapshotted transaction.

    Raises:
        TransactionNotFoundError: When no transaction owned by ``user_id`` matches
            ``command.id`` (a cross-tenant id is not found, ADR-108/ADR-111).
    """
    async with uow:
        existing = await uow.transactions.get(command.id, command.user_id)
        if existing is None:
            raise TransactionNotFoundError(command.id)
        # The snapshot setter is the explicit backfill/rate-fill path (ADR-149): always
        # re-materialize the USD figure from the authoritative amount, even when no
        # fx_source is given. Passing the computed usd_amount makes the recompute hold
        # for a USD row whether or not the domain's snapshot-keyed recompute fires.
        usd_amount = materialize_usd_amount(existing.amount, command.fx_rate)
        snapshotted = build_transaction(
            transaction_id=existing.id,
            created_at=existing.created_at,
            updated_at=datetime.now(UTC),
            user_id=existing.user_id,
            occurred_on=existing.occurred_on,
            name=existing.name,
            kind=existing.kind,
            amount=existing.amount,
            currency=existing.currency,
            usd_amount=usd_amount,
            fx_rate=command.fx_rate,
            fx_source=command.fx_source,
            fx_rate_type=existing.fx_rate_type,
            fx_rate_as_of=existing.fx_rate_as_of,
            category=existing.category,
            payment_method=existing.payment_method,
            card=existing.card,
            notes=existing.notes,
            recurring=existing.recurring,
            counts_toward_monotributo=existing.counts_toward_monotributo,
            statement_document_id=existing.statement_document_id,
            account_id=existing.account_id,
        )
        await uow.transactions.persist(snapshotted)
        await uow.commit()
    return snapshotted.id


async def delete_transaction(command: DeleteTransaction, uow: AbstractUnitOfWork) -> None:
    """Hard-delete a transaction by identity (ADR-030).

    Args:
        command: The validated delete request.
        uow: The unit of work providing the transaction repository.

    Raises:
        TransactionNotFoundError: When no transaction matches ``command.id``.
    """
    async with uow:
        removed = await uow.transactions.delete(command.id, command.user_id)
        if not removed:
            raise TransactionNotFoundError(command.id)
        await uow.commit()


def _apply_patch(existing: Transaction, command: UpdateTransaction) -> Transaction:
    """Build a new aggregate overlaying the patch's present fields.

    Rebuilding through :func:`build_transaction` re-runs the domain invariants
    so the patched state is validated and normalized, while preserving identity,
    ``created_at`` and ownership (``user_id``) and bumping ``updated_at`` to now
    (ADR-026, ADR-031, ADR-108). Ownership is never patchable — a patch must not
    move a row to another tenant. ``card`` is not a patchable field: the edit form
    never sends it, so it is carried over unchanged from the existing row so an edit
    that changes other fields never wipes the imported card detail (ADR-117).
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
        user_id=existing.user_id,
        card=existing.card,
        **fields,
    )
