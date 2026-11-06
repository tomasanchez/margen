---
project: margen
adr: 218
title: "One expense may be linked from many receivable items; non-blocking over-sum warning"
category: business
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-218: One expense may be linked from many receivable items; non-blocking over-sum warning

## Context

A shared expense (e.g. a dinner split among several friends) needs one `receivable_item` per person owed, all referencing the same single expense transaction via `source_transaction_id` (ADR-217). A uniqueness constraint on the link would make this common case unrepresentable.

## Decision

No uniqueness constraint on `receivable_item.source_transaction_id` — many items, across different people, may link the same expense. The UI warns, non-blockingly, when the sum of all items currently linked to an expense exceeds that expense's own amount — this flags a likely data-entry mistake (e.g. double-splitting someone) without preventing a legitimate edge case such as an unevenly split tip or surcharge.

## Alternatives Considered

- **Unique link (one item per expense)**: cannot model a shared expense split among multiple debtors — the primary intended use case for this feature — rejected.

## Consequences

- Item save needs a "sum of items linking this transaction" check, scoped to the `transaction_id`.
- A reader for "all receivable items linking transaction X" is needed to power both the warning and the transaction-side entry point (ADR-220).
- The warning is UI-layer only — no hard DB constraint.
- Relates to ADR-217 (the link column this governs cardinality for), ADR-220 (entry points where the warning surfaces).

## Status History

- 2026-11-06: accepted
