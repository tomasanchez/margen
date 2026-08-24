---
project: margen
adr: 202
title: A reimbursement attributes to a chosen receiving account
category: data
date: 2026-08-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-202: A reimbursement attributes to a chosen receiving account

## Context

ADR-162's per-surface inclusion matrix states that a reimbursement's account-balance and net-worth rows are `YES` — "Full ARS inflow — real cash entered the account (same as any deposit)." In practice this row was dead: ADR-161 established that a reimbursement carries no FX snapshot of its own, and the implementation went further than that ADR required by also persisting `account_id = NULL` on every reimbursement. The Add/Edit Transaction form never exposed an account picker for `kind='reimbursement'`, so there was no way for the owner to set one.

The backend's `_SIGNED_DELTA` balance computation already credits a reimbursement to its `account_id` when one is set — the gap was frontend-only. The owner reported the concrete symptom: reimbursements received into Mercado Pago (ARS) were invisible in account balances and net worth, contradicting the "YES" rows of ADR-162.

## Decision

- The Add/Edit Transaction form now exposes an account selector for `kind='reimbursement'` — the same account picker used for other transaction kinds, filtered to accounts matching the reimbursement's currency (ARS today, per the currency-filter invariant of ADR-122/ADR-123).
- The selector defaults to no account (`account_id = NULL` remains a valid, allowed state — behaves exactly as before for that row); the owner picks the account that actually received the payback.
- The chosen `account_id` is persisted on the reimbursement row and credits that account's balance and net worth exactly like any other deposit, via the existing `_SIGNED_DELTA` logic — no backend change is required.
- This realizes ADR-162's "Account balance: YES" / "Net worth: YES" rows for the first time in practice.
- This **supersedes the "reimbursement carries no account" stance implied by the ADR-161-era implementation**. ADR-161 itself is otherwise unchanged: a reimbursement still carries no FX snapshot of its own, and its USD value is still derived from the linked expense's FX rate.
- All other reimbursement semantics are unchanged: still nets category spend against the linked expense (ADR-160), still excluded from ordinary income totals, savings-rate numerator, and Monotributo trailing-12 turnover (ADR-158, ADR-162).
- **Data backfill:** pre-existing reimbursement rows with `account_id = NULL` are corrected via a one-off production data update to their actual receiving account (Mercado Pago ARS), so historical balances reflect real cash already received.

## Alternatives Considered

- **Keep reimbursements account-less, netting category spend only (status quo)**: rejected — directly contradicts ADR-162's balance/net-worth inclusion rows and leaves the owner's balances understated relative to real cash on hand.
- **Auto-attribute the reimbursement to the SAME account as the linked expense**: rejected — the payback is frequently received into a different account than the one that paid (e.g., expense charged to a card or bank account, refund received into Mercado Pago); auto-linking would misstate which account actually holds the cash.
- **Infer the receiving account from transaction name/description**: rejected — unreliable, no structured signal to key off, would silently mis-assign cash.

## Consequences

- Reimbursement balances and net worth are now accurate, closing the gap between ADR-162's stated contract and the implementation.
- `account_id` remains optional on a reimbursement — `NULL` is still a valid state (e.g., owner hasn't decided, or genuinely untracked cash) and behaves as before for that row.
- No schema change: `transactions.account_id` already exists (ADR-122). This is a frontend-only change plus a one-off prod data backfill correcting historical `account_id = NULL` reimbursement rows to Mercado Pago ARS.
- Preserves the currency-filter invariant: an ARS reimbursement can only be linked to an ARS account (ADR-122/ADR-123); USD reimbursements into USD accounts remain a possible future extension — today reimbursement amounts are ARS only.
- ADR-161's FX-derivation rule (USD value inherits the linked expense's rate) is unaffected and continues to govern the budget/spend USD representation; this ADR governs only the balance-sheet/account-attribution side.
- Relates to ADR-158 (reimbursement inflow kind), ADR-159 (offset link to expense), ADR-160 (net category spend), ADR-161 (USD value inherits linked expense FX rate — status history updated to note this ADR), ADR-162 (per-surface inclusion matrix — this ADR realizes its balance/net-worth rows), ADR-122/ADR-123 (account currency + net worth aggregation).

## Status History

- 2026-08-24: accepted
