---
project: margen
adr: 195
title: Card-payment planner uses the projected due-date balance, not the raw balance
category: architecture
date: 2026-07-07
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-195: Card-payment planner uses the projected due-date balance, not the raw balance

## Context

ADR-188 computes a per-currency card-payment sufficiency check: does each funding account hold enough to cover the statement balance? ADR-189 produces a greedy list of suggested funding legs. Both ADR-188 and ADR-189 compare account balances against amounts due, but they use the raw ADR-186 as-of-today snapshot.

Two bugs exist under that model:

1. **Source-side double-source bug:** If an account already has a future-dated outgoing transfer (`pendingOut` from ADR-193), the planner still treats the full raw balance as available. The same funds can be "committed" to a second card payment — they are promised twice.

2. **Scheduled top-up blindness:** If the user has a future-dated incoming transfer into the pay-from account (e.g., a paycheck scheduled via ADR-191 to land before the due date), the planner does not see it. The account looks underfunded when it will actually be sufficient.

ADR-193 defines the `{ balance, pendingOut, pendingIn }` primitive. The planner should use the projected-on-due balance derived from that primitive as the effective available amount for each funding candidate.

A known remaining gap (deferred to Slice B / ADR-196): when a prior card's payment is committed, it consumes the pay-from account. Today paying a card is not modelled as a transfer, so the earmark does not yet enter `pendingOut`. The multi-card case (an account simultaneously funding card A and card B) is therefore not fully correct in Slice A. ADR-196 will model card payments as future-dated bank→card transfers, causing each commitment to appear as `pendingOut` and making the multi-card scenario correct.

## Decision

**Projected-on-due balance for each funding account:**

```
projected = balance + pendingIn − pendingOut
```

derived from the ADR-193 primitive. The planner (ADR-188/189) uses `projected` instead of `balance` when evaluating whether an account can cover a shortfall and when generating greedy transfer legs.

**Effect on the source-side double-source bug:**
An account's already-scheduled outgoing transfers (e.g., a previously earmarked card payment) are subtracted from its effective available balance. The account cannot be committed twice for the same funds.

**Effect on scheduled top-ups:**
A future-dated incoming transfer (e.g., a salary deposit scheduled to land before the due date) is added to the projected balance. The account correctly reads as fundable for the planner.

**Per-currency native:**
`pendingIn` and `pendingOut` are per-currency native amounts (ADR-133, ADR-193). No cross-currency conversion inside the planner.

**Deferred gap — destination earmark (Slice B):**
When the planner assigns funds to cover card A, that commitment is not yet modelled as a future-dated transfer (because paying a card is not a transfer today). Therefore the multi-card case — account X covering card A and card B in the same planning session — can still double-source account X within one planning session. ADR-196 (Slice B) will model the card payment as a bank→card future-dated transfer, which causes the earmark to enter `pendingOut` and makes the multi-card case fully correct. Slice A alone corrects the source side (existing prior commitments) plus the transaction selector (ADR-194).

**Scope:** Frontend only. No migration, no endpoint, no change to ADR-186 backend snapshot. ADR-188/189 planner logic is updated to source projected balances from the ADR-193 helper.

## Alternatives Considered

- **Keep raw `balance` (ADR-186 snapshot) in the planner**: Retains the source-side double-source bug; an account with prior earmarks appears fully available; rejected.
- **Backend projected-balance field**: Data is already on the client; no non-client consumer exists yet; consistent with ADR-193's rationale for client-side derivation; rejected for now.
- **Include destination earmark within Slice A**: Would require tracking intra-session commitments in transient state; deferred to Slice B (ADR-196) where card payments become real transfers and the earmark enters `pendingOut` naturally.
- **Block the multi-card planner until Slice B**: Forces the user to wait for a complete fix before getting any improvement; Slice A already closes the most common gap (prior external commitments); rejected.

## Consequences

- The payment planner accurately reflects prior earmarks: an account whose funds are already committed to another future-dated transfer correctly shows reduced availability.
- Scheduled incoming top-ups contribute to the projected balance and can make an otherwise-underfunded account viable for the planner.
- The multi-card double-source gap remains in Slice A and is the primary driver for ADR-196 (Slice B).
- ADR-194 and ADR-195 together make the ADR-193 primitive useful in both the transaction add/edit flow and the card-payment planning flow.
- Relates to ADR-045 (currency-filtered account selection), ADR-066 (selector filter test coverage), ADR-133 (per-currency native amounts — governs pendingIn/pendingOut isolation), ADR-185 (cc unpaid balance — net-worth model, unchanged), ADR-186 (as-of-today balance snapshot — the `balance` component, sacrosanct), ADR-188 (per-currency sufficiency check — updated to use projected balance), ADR-189 (greedy transfer suggestion — updated to use projected balance), ADR-191 (future-dated transfers — the source for pendingIn/pendingOut), ADR-193 (available-balance primitive — the helper consumed here), ADR-194 (transaction selector — the parallel Slice A consumer of ADR-193). ADR-196 (Slice B — destination earmark via card-payment-as-transfer) is the deferred follow-up.

## Status History

- 2026-07-07: accepted
- 2026-07-14: superseded by ADR-198 (card-payment planner removed from the import flow; the ADR-193 primitive is retained for ADR-194 only)
