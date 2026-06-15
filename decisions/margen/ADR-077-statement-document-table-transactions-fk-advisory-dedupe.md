---
project: margen
adr: 077
title: statement_document Table (1:N) + transactions.statement_document_id FK; Advisory Dedupe by Natural Key
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-077: statement_document Table (1:N) + transactions.statement_document_id FK; Advisory Dedupe by Natural Key

## Context

One uploaded CC statement produces many transactions, unlike the ARCA invoice 1:1 relationship in ADR-071. Re-uploading the same statement must be detectable to prevent duplicate expenses. The original PDF must be stored for audit and reference (mirroring the invoice document storage in ADR-071). A storage abstraction is needed so the Postgres MVP adapter can be swapped for object storage later without caller changes.

## Decision

Add a `statement_document` table (via Alembic migration) with columns: PDF bytes (`BYTEA`), `content_type`, `byte_size`, `extracted_text`, `bank_name`, `network`, `card_last4`, `issuer_cuit`, `statement_number`, `period_close` (date), `period_due` (date), `total_amount` (`Numeric`/`Decimal`). Add a nullable `statement_document_id` foreign-key column on the `transactions` table (the many side) so each imported expense links back to its source statement. PDF bytes are accessed through a storage port (`AbstractStatementStore`) whose only concrete adapter today is Postgres (future Azure Blob is a drop-in replacement, mirroring ADR-071). For dedupe, the parse endpoint computes a natural key (`issuer_cuit + card_last4 + statement_number`) and returns a flag when a matching document already exists; the UI warns the user but does not block import. All monetary fields remain `Decimal` (ADR-025).

## Alternatives Considered

- **Reuse `invoice_document` table**: Wrong cardinality (1:1 vs 1:N) and schema shape — creates coupling and awkward NULLs; rejected.
- **Join table between statements and transactions**: Unnecessary indirection for a pure 1:N relationship; a FK on the many side is simpler and sufficient; rejected.
- **Hard-block duplicate statement imports**: Warn-and-proceed is less restrictive for a personal-use app where re-importing may be intentional (partial corrections); chosen advisory approach.

## Consequences

- Every imported expense transaction carries a direct FK to its source statement document, enabling "show me the original PDF" and "which transactions came from this statement" queries.
- The nullable FK column means manually-entered transactions are unaffected (ADR-028 lean aggregate — a nullable link column is accepted).
- The storage port keeps Postgres as the sole persistence dependency for MVP while enabling object storage as a drop-in later.
- Advisory dedupe avoids blocking re-imports but shifts deduplication responsibility partly to the user.
- Relates to ADR-071 (invoice document storage pattern and storage port), ADR-025 (Decimal money), ADR-028 (lean aggregate model), ADR-077 (this record) is referenced by ADR-078 (import endpoint unit of work).

## Status History

- 2026-06-14: accepted
