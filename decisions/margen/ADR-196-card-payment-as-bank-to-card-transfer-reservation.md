---
project: margen
adr: 196
title: Card payment as bank-to-card transfer reservation closing the destination-earmark gap
category: architecture
date: 2026-07-07
status: superseded
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-196: Card payment as bank-to-card transfer reservation closing the destination-earmark gap

## Context

ADR-191 introduced one-click scheduling of funding legs (bank→bank top-ups) as future-dated own-account transfers. ADR-195 made the payment planner use the projected-on-due balance (`balance + pendingIn − pendingOut`) so that prior earmarks reduce a pay-from account's effective availability.

ADR-195 explicitly deferred one gap — the **destination earmark**: when the user schedules a statement payment for card A, that commitment is not yet modelled as a future-dated transfer. Paying a card was not creating a bank→card transfer, so the earmark never entered `pendingOut` of the pay-from account. Consequently, the multi-card scenario (account X funding both card A and card B in the same planning session, or across separate sessions) could double-source account X: the planner for card B sees the full balance of X even after X has already been committed to card A's payment. The owner's Bank-B example: after committing 6 units to card A, card B's planner should see 7 remaining, not 13.

ADR-135 already allows own-account transfers between any two owned accounts regardless of institution type; the transfer validation only enforces ownership, `from ≠ to`, and positive legs. A bank→card transfer is therefore structurally valid without any backend change. ADR-186 already excludes future-dated transfers from the as-of-today balance, and ADR-193 already counts future-dated transfers as `pendingOut`/`pendingIn` in the availability overlay.

## Decision

**Payment leg created alongside the funding legs:**

When the user triggers the ADR-191 "Schedule transfers" action, IN ADDITION to the top-up funding legs (bank→bank transfers into the main/pay-from account), also create a **payment leg**: a future-dated own-account transfer from the main/pay-from account → the card's account of the same currency. This uses the same `POST /transfers` endpoint (ADR-135). No new endpoint, no new aggregate, no schema change.

**Per-currency payment legs:**

A local card may bill in both ARS and USD (ADR-133). For each currency in which the statement carries a balance, one payment leg is created — from the pay-from account's matching currency account into the card's matching currency account. Up to two payment legs per card statement.

**Amount of each payment leg:**

The payment leg amount equals the statement's total for that currency — the ADR-188 Need for that currency. This matches the card debt exactly.

**Dating rule (consistent with ADR-091/ADR-191):**

- If `today < statement.period_due`: `occurred_on = statement.period_due`.
- If `today >= statement.period_due`: `occurred_on = today`.

**Effect on `pendingOut`:**

Once created, the payment leg is a future-dated outgoing transfer from the pay-from account. The ADR-193 primitive immediately counts it as `pendingOut`. The ADR-195 projected balance for that account drops by the payment amount. Any subsequent card planner run (same session or a later session) sees the committed funds as unavailable. The multi-card double-source gap is closed durably — the reservation persists as a real transfer record.

**Schedulability (payment-only plans):**

The ADR-191 schedule action was originally gated on there being at least one coverable top-up leg. Because the payment leg is now the point of the action, schedulability is broadened: the action is available whenever the plan has **any firable leg** — a coverable top-up OR a payment leg (a currency with `need > 0` and an attached card account). This makes the primary reservation case schedulable: when the pay-from account already covers the whole statement (zero top-ups), the user can still schedule the payment so the earmark enters `pendingOut` and the next card's planner sees the funds committed. A currency that is sufficient but has no attached card contributes no leg. Concretely, schedulability is derived from the same leg list that is fired (non-empty → schedulable), so the button, the fire order, and the resume cursor share one source of truth.

**Scope:** Primarily frontend — the "Schedule transfers" action is extended to emit the extra payment leg(s) and to become available for payment-only plans. Backend: no production code change required (the transfer and balance logic already handle a bank→card transfer generically). Backend regression tests must be added (see Consequences).

## Double-Count Resolution

This is the load-bearing correctness item.

**The `cc_balance` liability (ADR-185)** sums card-account **expense charges** with `occurred_on > today`. It does not include transfers. The payment leg is a **TRANSFER**, not an expense — it never enters `cc_balance` under any circumstance.

**While the payment is pending (`occurred_on > today`):**

| Figure | Effect |
|---|---|
| `cc_balance` (ADR-185 liability) | Unchanged — still equals the sum of future expense charges on the card account. |
| Pay-from account as-of-today balance (ADR-186) | Unchanged — future-dated transfers are excluded from the balance snapshot. |
| Pay-from account `pendingOut` (ADR-193) | Increases by the payment amount — the reservation is visible in the availability overlay. |
| Pay-from account projected balance (ADR-195) | Decreases by the payment amount — planner sees the funds as committed. |
| Net worth | Unchanged — neither the pending transfer nor the liability changed. |

The `cc_balance` liability (a net-worth lens: you owe this) and the `pendingOut` reservation (a cash-flow lens: this cash is spoken for) are different, non-overlapping views. They are never summed together. No figure counts the obligation twice.

**On the due date (`occurred_on <= today`):**

The card expense charge (`−amount`) and the payment transfer (`+amount_in`) both have the same `occurred_on` and both settle into the card account balance. They cross: the card nets to approximately zero. The bank's settled balance drops by the payment amount. The charge is no longer future-dated, so it leaves `cc_balance`. Net result: "you paid the card." Neither the charge nor the payment is ever simultaneously a settled balance AND a pending liability.

**Invariant (must be tested and preserved):**

> `cc_balance` MUST NOT be reduced by a pending payment transfer. `cc_balance` stays charge-only. A pending payment only affects the availability overlay (`pendingOut`) and, after the due date, the settled balance.

Violating this invariant would double-count: reducing the liability AND reserving the bank for the same obligation.

## Alternatives Considered

- **Track intra-session commitments in transient UI state**: Would close the gap within a single planning session but loses the reservation after a page reload or on the next session; other users or future planners would not see the earmark; rejected.
- **Backend projected-balance endpoint returning `pendingOut`**: The data is already on the client from ADR-193; no non-client consumer exists; consistent with ADR-193's rationale for client-side derivation; deferred — the transfer record approach closes the gap without a new endpoint.
- **Block multi-card planning until this slice ships**: Slice A (ADR-195) already closes the most common gap (prior external commitments); blocking would delay a useful improvement; rejected.
- **Reduce `cc_balance` by the pending payment**: Would double-count (reducing the liability while also reserving the bank for the same obligation); explicitly rejected — the invariant above forbids it.
- **Model payment as a new `card_payment` aggregate**: No new semantics beyond "future-dated own-account transfer"; a separate aggregate adds schema complexity with no benefit; rejected.

## Consequences

- The pay-from account's `pendingOut` is increased as soon as the payment is scheduled, so the ADR-195 projected balance correctly reflects committed funds across sessions and cards.
- The multi-card scenario (the Bank-B 6-vs-7 example) now yields the correct answer: after committing funds to card A's payment, card B's planner sees the reduced available balance.
- The card debt continues to appear as a `cc_balance` liability (ADR-185) until the due date — scheduling a payment only reserves the cash, it does not extinguish the liability early. This is correct: the debt remains until the bank transfer actually settles.
- Editing or cancelling a scheduled payment uses the standard transfers UI — no new UI surface needed (consistent with ADR-191).
- A partial or mismatched payment (payment leg < charge amount) leaves a residual card balance after settlement — correct behavior indicating underpayment.
- **Backend regression tests required:** A future-dated card expense charge + an equal future-dated bank→card payment → while pending: `cc_balance` = charge amount, net worth unchanged, pay-from `pendingOut` = payment amount; after the due date: card account nets to ~0, `cc_balance` drops, bank balance drops, no double-count at any point.
- Relates to ADR-089 (due-date `occurred_on` convention — reused here for the payment leg), ADR-133 (per-currency native amounts — one payment leg per currency), ADR-135 (own-account transfers — the endpoint used for the payment leg), ADR-185 (cc unpaid balance liability — charge-only; payment transfers never enter it), ADR-186 (as-of-today balance excludes future-dated transfers — keeps pending payment invisible to settled balance), ADR-188 (per-currency sufficiency check — the Need that sizes the payment leg), ADR-189 (greedy transfer suggestion — the funding legs emitted alongside the payment leg), ADR-191 (schedule-transfers action — extended here to also emit the payment leg), ADR-193 (available-balance primitive — `pendingOut` is the reservation signal this ADR populates), ADR-195 (projected due-date balance — consumes `pendingOut` to close the destination-earmark gap that this ADR resolves).

## Status History

- 2026-07-07: accepted
- 2026-07-07: clarified before merge — schedulability broadened from the ADR-191 top-up-only gate to "any firable leg" so payment-only plans (funds already sufficient) are schedulable, which is the primary reservation case. Recorded after code review flagged that a fully-covered statement had no path to schedule its payment.
- 2026-07-14: superseded by ADR-198 (bank-to-card payment-leg reservation retired; no card accounts exist to target)
