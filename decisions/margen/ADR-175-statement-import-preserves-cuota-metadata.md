---
project: margen
adr: 175
title: Statement import preserves the parsed cuota as structured installment metadata
category: data
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-175: Statement import preserves the parsed cuota as structured installment metadata

## Context

The Galicia statement parser (`statement_parser.py`) already extracts `Cuota N/M` from credit-card PDF line items and stores the values internally. The current import command drops this structured signal to a free-text note on the resulting transaction, making it machine-unreadable for the forecast engine.

ADR-174 adds `installments_total` and `installments_index` to the transaction aggregate. The parser already has the data — the only gap is plumbing it through the import pipeline rather than discarding it.

## Decision

Recover the parsed cuota as structured installment metadata on import:

1. `StatementLineInput` (the internal DTO) gains two optional fields: `installments_index: int | None` and `installments_total: int | None`.
2. `CreateTransaction` (the command) accepts and persists those fields to the new columns (ADR-174).
3. The statement parser populates `StatementLineInput.installments_index/total` from its already-parsed `Cuota N/M` token.
4. The import review table surfaces these fields as editable columns so the user can correct a misparse before confirming.
5. The `recurring_cadence` is auto-set to `'installment'` when `installments_total` is present.

No backfill of previously imported transactions. The parser change is near-zero-cost: the extraction logic already exists; only the discard step is removed.

## Alternatives Considered

- **Keep cuota in a free-text note (current)**: The note is already populated; making it structured requires only the plumbing; keeping free-text wastes a signal the parser already has; rejected.
- **Post-import enrichment via a separate command**: User manually tags installments after import — adds a step and risks forgetting; the parser signal is available at import time at no extra cost; rejected.
- **Derive installments at read time from the note field**: Fragile; notes are user-editable free text; the note format is not guaranteed; rejected.

## Consequences

- Imported installment transactions automatically populate `installments_index`, `installments_total`, and `recurring_cadence='installment'` — the forecast engine (ADR-176) can project their remaining tails without user re-entry.
- Misparses are caught in the import review table before commit — the editable columns provide a correction surface.
- The plumbing path is: parser → `StatementLineInput` → `CreateTransaction` → DB. No new tables, no new endpoints beyond the existing import flow.
- Previously imported installment transactions remain unstructured (nullable columns, free-text note only) until the user edits them or a future backfill tool is built.
- Relates to ADR-075/ADR-076 (statement import and parser architecture), ADR-079 (statement line-to-transaction field mapping — extended here), ADR-080 (import review table — gains installment columns), ADR-174 (the columns being populated), ADR-176 (forecast engine that consumes the result).

## Status History

- 2026-07-02: accepted
