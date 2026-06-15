---
project: margen
adr: 085
title: Matching Heuristic and Import Resolution Semantics
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-085: Matching Heuristic and Import Resolution Semantics

## Context

ADR-084 decided that flagged lines are reconciled per-line at review time. Two precise, testable definitions are needed: (1) what makes a statement line "likely the same" as an existing transaction, and (2) what each resolution choice actually does to the database on import.

## Decision

### Match heuristic (pure, unit-testable)

A statement line matches an existing transaction when **all three** conditions hold:

1. **Amount is exact** — ARS amounts match to the cent.
2. **Date is within ±N days** — `occurred_on` of the candidate falls within a configurable window (default N ≈ 3) of the statement line's date.
3. **Names are leniently similar** — after normalization (casefold, accent/punctuation strip), names match when they share a **significant word in any position** (4+ chars, non-numeric — so a brand at the end like "Sushi Hatsu" ≈ "Hatsu" counts), OR one normalized name is a **prefix** of the other ("Sushi" ⊂ "Sushiclub"), OR a **high** SequenceMatcher ratio (~0.85) catches a misspelling. The bar is **intentionally lenient**: because **amount-exact + date-within-window already gate every candidate** and every flag is **reviewed** before anything is written, a missed duplicate (false negative → a silent duplicate) costs more than an over-flag the user dismisses with one click. A one-token brand like "Sushiclub" still won't match "Fabric Sushi"/"Kawaii Sushi" (no shared word). (Brand-prefix and leading-token variants were considered and rejected: keying on the first token misses an end-of-name brand like "Sushi Hatsu" and collides on a shared generic leading word; given the amount+date pre-gate, leniency is the better trade-off.)

Candidate pool: only **manual** expenses — `kind=expense` with `statement_document_id IS NULL` — so already-imported statement rows are never re-matched. Assignment is **greedy 1:1**: a candidate can be claimed by at most one statement line; when two lines could match the same candidate, the one with the nearest date wins. The candidate set is fetched once per parse over the date window spanning all lines in the statement; the matching logic itself is a pure function with no I/O.

### Resolution semantics on import (one unit of work)

Each import line carries a `resolution` field:

| Resolution | Meaning | Effect |
|---|---|---|
| `import` | No match found | Create a new EXPENSE transaction linked to the statement document (as per ADR-079). |
| `keep_both` | Match found but user chose to keep both | Create a new EXPENSE transaction linked to the document; existing transaction unchanged. |
| `merge` | Match found; user accepted merge | Do **not** create a new transaction. Enrich the existing transaction: set `statement_document_id` to the saved document, set `payment_method` to the statement card, fill `category` only if it was empty, set `notes` to the cuota marker only if existing notes were empty. The existing `id`, `name`, `amount`, `occurred_on`, `currency`, and non-empty `notes` are preserved (the user's manual entry is source of truth for those fields). |

For `merge` the `match_transaction_id` field carries the id of the existing transaction to enrich. All creates, merges, and the document save commit atomically in a single unit of work (ADR-028).

## Alternatives Considered

- **Amount + date only (no name guard)**: Higher false-positive rate — two unrelated same-amount charges on nearby dates would be flagged — rejected; fuzzy name similarity accepted at the cost of potentially missing a match where names differ beyond the threshold.
- **Replace existing with statement values**: Loses the user's manual edits (name, notes) — rejected; manual entry is source of truth for preserved fields.
- **Merge updates amount and date**: The statement's posted values can differ from the actual charge date/amount the user recorded — rejected; user's manual entry wins.

## Consequences

- The heuristic is a pure function and fully unit-testable without a database (see ADR-087).
- The ±N-day window and similarity threshold are configurable constants; defaults must be tuned against real statement samples.
- Greedy 1:1 assignment means a single manual transaction cannot be consumed twice; edge cases with multiple same-amount lines on the same day default to the nearest-date winner.
- Relates to ADR-077/079 (dedupe, field mapping), ADR-026/027/031 (identity, kind, lenient validation), ADR-028 (unit of work), ADR-030 (REST contract), ADR-084 (reconciliation business decision).

## Status History

- 2026-06-14: accepted
