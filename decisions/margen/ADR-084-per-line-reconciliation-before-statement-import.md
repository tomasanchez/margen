---
project: margen
adr: 084
title: Reconcile Statement Lines Against Existing Transactions Before Import
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-084: Reconcile Statement Lines Against Existing Transactions Before Import

## Context

ADR-075 introduced credit-card statement import. A user may log an expense manually mid-month; when the monthly statement later arrives, naively importing every line (ADR-075) would double-count that charge. Statement-level deduplication (ADR-077) only prevents re-importing a statement document that was already fully imported — it does not detect when a single manually-entered transaction corresponds to a line in a new statement.

## Decision

At parse time, each statement line is tested against existing transactions for a likely match. Lines that match are flagged. At the review step (ADR-080) the user resolves each flagged line individually. The default resolution for a flagged line is **Merge** (treat as the same expense; highlighted for attention). The user may switch a row to **Keep both** (the charge is genuinely separate) or **Edit** the row before confirming. Unflagged lines import normally without any additional user action.

## Alternatives Considered

- **Statement-level dedupe only (ADR-077)**: Prevents re-importing the same PDF but does not catch the case of a single manually-entered expense matching one line in a new statement — rejected as insufficient.
- **Auto-merge without review**: Amounts and merchant names from statements can differ from manual entries; silent merging risks data loss — rejected; user confirmation is required.
- **Hard-block on match**: A legitimate same-amount charge on the same day at the same merchant (e.g., two coffees) must still be importable — rejected; per-line resolution preserves that ability via **Keep both**.

## Consequences

- Duplicate expenses are surfaced to the user rather than silently created or silently dropped.
- The review step (ADR-080) gains a new flagged-row variant; implementation complexity increases.
- Matching must be fast enough to run inline at parse time without degrading the upload response.
- Relates to ADR-075 (statement import scope), ADR-077 (advisory statement-level dedupe), ADR-079 (line-to-transaction field mapping), ADR-080 (review table UX).

## Status History

- 2026-06-14: accepted
