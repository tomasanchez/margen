---
project: margen
adr: 185
title: Credit-card unpaid-balance liability equals future-dated non-installment card-account charges
category: data
date: 2026-07-03
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-185: Credit-card unpaid-balance liability equals future-dated non-installment card-account charges

## Context

ADR-180 introduced a `liabilities.cc_balance` placeholder (null in Slice 1). ADR-089 decided that imported CC statement lines are dated on the statement **due date** — the date the charge must be paid, not the purchase date. This means a charge's `occurred_on` is in the future until that due date passes.

ADR-184 now attaches imported lines to a specific card account. With account attachment and due-date dating in place, a card's unpaid balance can be derived directly from existing transaction rows without any new schema.

Installment-tagged charges (`recurring_cadence='installment'`) are already counted in `liabilities.installments` (ADR-181) as the remaining cuota tail. Including them again here would count the same peso twice.

## Decision

A card account's **unpaid balance** = the sum of its card-account charges whose `occurred_on` is **in the future** (i.e., `occurred_on > today`), **excluding** rows tagged `recurring_cadence='installment'`.

Formally:

```
cc_balance(account) =
  Σ amount
  WHERE account_id = <card account>
    AND kind = 'expense'          -- charges only, not credits/refunds
    AND occurred_on > today
    AND (recurring_cadence IS NULL
         OR recurring_cadence != 'installment')
```

**Why future-dated = unpaid:** Per ADR-089, imported CC charges are dated on the due date. A charge dated today or earlier has already been due (and is presumed settled in the account balance). A charge dated tomorrow or later has not yet been due — it is the outstanding obligation.

**Installment exclusion:** Installment cuotas are already captured in `liabilities.installments` (ADR-181). Excluding them here enforces the no-double-count invariant: each peso is counted exactly once — either as a settled expense, as a remaining installment tail, or as an unpaid non-installment CC charge.

**Currency:** Results are expressed as a native ARS/USD breakdown per account, matching the account's denomination. Conversion to the net-worth display currency follows ADR-183's live-rate pattern, populating `liabilities.ccBalanceNative` on the response and extending the `net_after_liabilities` derivation.

**Populates:** `liabilities.cc_balance` (ADR-180) and the new `liabilities.ccBalanceNative` breakdown (ARS/USD subtotals at the live display rate — ADR-183).

## Alternatives Considered

- **Derive from a separate "pending" status flag on transactions**: Requires a new writable field and a pending→settled lifecycle; ADR-089's due-date convention makes this unnecessary — the date alone encodes the settled/unsettled state for imported CC lines; rejected.
- **Include installment cuotas in cc_balance (unified CC liability)**: Double-counts installment tails that are already in `liabilities.installments`; violates the no-double-count invariant (ADR-186); rejected.
- **Aggregate at statement level (per-statement outstanding total)**: Statement granularity is not stored post-import; per-transaction aggregation is the only available level; rejected as impractical.
- **Snapshot unpaid balance at import time into a dedicated column**: Adds a write-time snapshot that goes stale as charges are paid off and new ones imported; the future-date derivation at read time is always current; rejected.

## Consequences

- `liabilities.cc_balance` is now populated (non-null) for any card account with future-dated non-installment charges; the ADR-180 placeholder becomes a live field.
- No new schema: the derivation queries existing `occurred_on`, `account_id`, and `recurring_cadence` columns.
- The due-date convention (ADR-089) is now load-bearing for the liability computation: if a user manually edits a CC charge's date to a past date, it falls out of the unpaid balance — consistent behaviour, but noteworthy.
- Refunds/credits (`kind != 'expense'`) are excluded; a future slice can decide whether a credit offsets the ccBalance.
- Relates to ADR-089 (due-date posting — foundation for future-dated = unpaid), ADR-130 (same-owner validation on account_id — ADR-184), ADR-174 (cadence fields used for installment exclusion), ADR-180 (cc_balance placeholder — now populated), ADR-181 (installment liability — excluded here to enforce no-double-count), ADR-183 (live-rate conversion of native ARS/USD breakdown), ADR-184 (account attachment — prerequisite for this query), ADR-186 (no-double-count invariant — this derivation enforces it).

## Status History

- 2026-07-03: accepted
- 2026-07-14: superseded by ADR-198 (no card accounts are produced by import; ccBalance liability becomes inert and the derivation no longer applies)
