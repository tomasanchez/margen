---
project: margen
adr: 203
title: "Receivables (money owed to me) tracker, kept out of net worth"
category: business
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-203: Receivables (money owed to me) tracker, kept out of net worth

## Context

The owner regularly lends people money or fronts shared costs and loses track of who owes them what, and why. They want to record people and itemized debts against each person, and be able to justify the total owed. This is fundamentally different from ADR-187's `Debt` aggregate: ADR-187 models money the OWNER owes (a net-worth liability feeding `liabilities.other`). The new need is the INVERSE — money owed TO the owner — and it is informal IOU tracking between people, not account-held cash. The money has not actually been received, so it must never be mistaken for real account balance or counted in net worth.

## Decision

Add a "receivables" feature: the owner can create People, and record itemized debts against each person (date, amount, optional detail note justifying the debt). This feature is tracked entirely separately from `accounts` and `transactions`, and its figures NEVER contribute to account balance or net worth (see ADR-205 for how this exclusion is enforced structurally, not by a filter). Scope is ARS-only for v1; USD receivables are deferred.

## Alternatives Considered

- **Model as a transaction `kind` excluded from balance sums** (mirroring the `reimbursement` precedent of ADR-158/159): reuse `transactions` with a new kind and exclude it from every balance/net-worth query — rejected: every balance and net-worth reader would need to remember the exclusion, and a single missed filter would silently leak unreceived IOU money into real balances.
- **Reuse the existing `Debt` aggregate (ADR-187)**: `Debt` is explicitly money the owner OWES, feeding `liabilities.other` in net worth. Receivables are the inverse (money owed TO the owner); folding them into the same aggregate would conflate an asset-like claim with a liability and risk leaking into `liabilities`/`assets` totals — rejected.

## Consequences

- New, isolated tables (ADR-204) with no relationship to `accounts` or `transactions` balance logic.
- No existing net-worth or balance code is touched by this feature.
- USD receivables and paid-history reporting are deferred to future slices.
- Relates to ADR-187 (Debt aggregate — the inverse liability concept; the two are deliberately kept as separate subsystems per ADR-205), ADR-158/159 (reimbursement precedent considered and rejected as the modeling approach here).

## Status History

- 2026-08-28: accepted
