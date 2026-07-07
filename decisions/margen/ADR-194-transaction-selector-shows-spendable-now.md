---
project: margen
adr: 194
title: Transaction account selector shows spendable-now, not raw balance
category: ux
date: 2026-07-07
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-194: Transaction account selector shows spendable-now, not raw balance

## Context

The Add/Edit transaction form includes an account picker. Today that picker shows account names and currency labels but no balance figure. A user who has scheduled future-dated outgoing transfers (ADR-191) sees the raw ADR-186 balance (or nothing) and may unknowingly assign spend against funds that are already earmarked — the over-commit problem.

ADR-193 defines a shared client primitive `{ balance, pendingOut, pendingIn }` derived from already-loaded data. This ADR decides how to surface that primitive in the transaction account selector specifically.

ADR-045/066 already filter the account option list by currency so only accounts matching the transaction's currency are shown. That filter is unchanged.

## Decision

**Spendable-now figure:**
Each account option in the Add/Edit transaction picker renders:

```
Spendable now = balance − pendingOut
```

derived from the ADR-193 primitive. This is the amount the user can actually allocate without over-committing already-earmarked funds.

**Pending-in display:**
If `pendingIn > 0`, a calm secondary caption is shown alongside the option:

```
+<amount> arriving
```

`pendingIn` is NEVER added to the spendable figure. Money not yet arrived must not read as spendable — adding it would recreate the over-commit bug in reverse (the user spends funds that may not materialise or may be delayed). It is shown separately as informational context only.

**Universal application:**
The spendable figure is shown for all accounts in the list, even those with no pending transfers (`pendingOut = 0`, `pendingIn = 0`). In that case `spendable = balance`, which is still an improvement over showing nothing.

**Currency:**
Amounts are displayed in the account's native currency. No cross-currency conversion in the picker (ADR-133). The option list is already currency-filtered (ADR-045/066), so all visible options share the transaction's currency.

**Scope:** Frontend only. No migration, no endpoint, no change to ADR-186 backend snapshot. The data to compute the ADR-193 primitive (balance + transfers list) is already fetched.

## Alternatives Considered

- **Show raw `balance` (ADR-186 figure)**: Ignores earmarked outflows; a user with a scheduled card payment would see more than is actually available; rejected — this is the bug being fixed.
- **Add `pendingIn` to the spendable figure**: Money not yet arrived is not spendable; presenting it as spendable recreates the over-commit problem in the opposite direction; rejected.
- **Show no balance (status quo)**: The picker provides zero guidance on which account has funds; even showing the raw balance is better, but spendable-now is strictly more accurate; rejected.
- **Server-computed available balance field**: The data is already on the client; a backend field would add a migration and endpoint for no gain until a non-client consumer exists (per ADR-193); rejected.

## Consequences

- The account picker conveys accurate spendability at a glance, reducing the risk of over-committing an already-earmarked account.
- Pending incoming transfers are visible as context but never inflate the spendable figure.
- The option list's currency filter (ADR-045/066) remains intact; no mixed-currency amounts appear in the picker.
- Relates to ADR-045 (USD add/edit flow — currency-filtered selector), ADR-066 (test coverage for the FX/currency filter — selector scope), ADR-133 (per-currency native amounts — no cross-currency sum in the picker), ADR-186 (as-of-today balance — the `balance` component), ADR-191 (future-dated transfers — the source for pendingIn/pendingOut), ADR-193 (available-balance primitive — the shared helper this ADR consumes), ADR-195 (card-payment planner — the other consumer of ADR-193).

## Status History

- 2026-07-07: accepted
