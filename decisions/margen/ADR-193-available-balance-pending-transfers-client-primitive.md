---
project: margen
adr: 193
title: Available balance = as-of-today balance net of pending transfers (shared client primitive)
category: architecture
date: 2026-07-07
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-193: Available balance = as-of-today balance net of pending transfers (shared client primitive)

## Context

ADR-186 established a sacrosanct as-of-today balance snapshot per account: the backend sums all transactions and transfers with `occurred_on <= today` and exposes a single figure. ADR-191 introduced future-dated transfers (`occurred_on > today`) as a reservation mechanism — a pending transfer is excluded from the ADR-186 balance because it has not taken effect yet.

This creates a gap between "what the balance reads" and "what is actually available to spend." A user who has scheduled a future-dated outgoing transfer (e.g., a card payment earmarked for next week via ADR-191) sees the full raw balance, even though that amount is already committed. Conversely, a pending incoming transfer (e.g., a scheduled top-up) is not yet visible in the balance but is reliably on the way. Both cases affect spendability.

The frontend already fetches both pieces of data — the ADR-186 balance snapshot and the transfers list (which includes future-dated records). Computing a spendable-now overlay from data already in memory requires no new backend endpoint or schema change.

ADR-133 prohibits cross-currency sums. ADR-185/186 define net worth (assets) using the raw balance. A "spendable" overlay must not redefine net worth.

## Decision

Define a **shared client-side primitive** `AvailableBalance` per account, per native currency:

```
{
  balance:    <ADR-186 as-of-today snapshot, unchanged>
  pendingOut: Σ amount_out  of future-dated transfers where account = this account
  pendingIn:  Σ amount_in   of future-dated transfers where account = this account
}
```

where "future-dated" means `occurred_on > today`.

**Computation:** Pure client-side helper function derived from the already-loaded transfers list (the same list that feeds the ADR-191 "Pending" badge). No backend field, no migration, no new endpoint.

**Invariants:**
- `balance` is the ADR-186 snapshot — never mutated by this primitive.
- `NetWorth.total` (assets) remains the sum of ADR-186 raw balances — not redefined here.
- Amounts are per-currency native; pendingOut and pendingIn are never cross-summed across currencies (ADR-133).

**Consumers** (defined in ADR-194 and ADR-195):
- Transaction account selector: displays `balance − pendingOut` as "spendable now."
- Card-payment planner: uses `balance + pendingIn − pendingOut` as the projected-on-due balance.

**Rationale for client-side over a backend field:**
Both data sources (balance snapshot + transfers list) are already fetched by the time any consumer renders. Spendability is a presentation overlay answering "can I spend this now?" — it is not a change to the net-worth definition. A backend field would be added only if a non-client consumer (e.g., a scheduled job, a report endpoint) requires it.

**Scope:** Frontend only. No migration, no endpoint, no change to ADR-186 backend snapshot.

## Alternatives Considered

- **Backend `available_balance` field on the account endpoint**: Would require a schema change or a computed column; the backend would need to know what counts as "pending" (replicating the ADR-191 date convention at the server layer); rejected unless a non-client consumer materialises.
- **Redefine `NetWorth.total` to use the available figure**: ADR-185/186 deliberately keep the net-worth asset figure as raw balance to avoid double-counting; blurring that boundary would undermine the net-worth model; rejected.
- **Cross-currency aggregation**: ADR-133 prohibits server-side cross-currency sums; the same constraint is respected client-side here; rejected.

## Consequences

- Any UI surface that wants to display spendability calls the shared helper — one implementation, consistent semantics everywhere.
- `balance` and `NetWorth.total` remain unchanged; the ADR-186 invariant is sacrosanct.
- Adding a backend field if a non-client consumer appears is a clean, additive future step that does not invalidate this ADR.
- Relates to ADR-133 (per-currency native amounts — governs the non-aggregation invariant), ADR-185 (cc unpaid-balance — net-worth model this primitive must not disturb), ADR-186 (as-of-today balance snapshot — the `balance` component of this primitive), ADR-191 (future-dated transfers / pending badge — the source list for pendingIn/pendingOut), ADR-194 (transaction selector consumer), ADR-195 (card-payment planner consumer).

## Status History

- 2026-07-07: accepted
