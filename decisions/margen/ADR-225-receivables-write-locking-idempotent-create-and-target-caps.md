---
project: margen
adr: 225
title: "Receivables write locking, idempotent item create, and per-target allocation caps (refines ADR-026/206/215/218/224)"
category: architecture
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-225: Receivables write locking, idempotent item create, and per-target allocation caps (refines ADR-026/206/215/218/224)

## Context

Code review of the installments feature (ADR-214/215/216/221/224) surfaced a batch of correctness and UX gaps that weren't covered by the earlier ADRs: concurrent requests against the same person could lose updates (e.g. a cuota edit racing a payment-triggered reshape, or a payment racing a delete that cascades over a just-written allocation); a client retry on item-create could either duplicate the item or silently create a second one with different terms; allocations were checked against the person's total outstanding (ADR-206) but not against the specific item/cuota they targeted, so a single allocation could overshoot its own target while still passing the person-level check; and several smaller edge cases (negative upcoming totals, over-split baseline for card cuotas, date bounds, payment-form UX) needed explicit rules. This ADR refines ADR-026 (server-generated ids), ADR-206 (overpayment), ADR-215 (due-only outstanding), ADR-218 (over-split warning), and ADR-224 (guard refinements) with the rules actually implemented after review.

## Decision

**1. Per-person pessimistic write lock.** Every receivables write (item create/edit/pardon/unpardon/delete, cuota edit/pardon/unpardon, payment, confirm-match) begins with `SELECT person FOR UPDATE`, so all checks-then-writes for a given person are serialized by that row lock. This fixes the lost-update windows where a concurrent cuota edit and payment, or a payment and a reshape-triggered cascade delete, could race and silently drop a committed allocation. Known residual gap (not covered by this ADR): two different people's payments both confirming against the *same* income transaction concurrently — this is a pre-existing race outside the per-person lock's scope and is left open.

**2. Reads tolerate a Σcuotas ≠ item.amount mismatch.** If an installment item's cuotas don't sum to the item's stored amount (a data inconsistency that shouldn't happen but can from a bad historical write), reads log a warning and derive the effective amount from Σ cuotas rather than raising — a single malformed row must not break the Owed tab for everyone.

**3. Idempotent, atomic item create — scoped deviation from ADR-026.** ADR-026 establishes server-generated UUID primary keys. For receivable items specifically, the client may supply the `id` on create: the same `id` with the same terms returns the existing item (replay-safe); the same `id` with *different* terms returns `409 item_id_conflict`. Per-cuota overrides (`installments.cuotas`) are accepted in the same create request and committed in the same transaction as the item and its generated schedule; the response includes `createdItemId`. This is deliberately scoped to receivable items only — it does not change id generation anywhere else in the system.

**4. Per-target allocation cap, on top of the person-level check.** In addition to ADR-206's person-level overpayment check, confirm-time now validates that an allocation does not exceed the remaining balance of its specific target (the item, or the cuota for installment items): `409 allocation_exceeds_target`, bypassed the same way as the person-level check via `allowOverpayment`. Separately, a cuota's `amount` cannot be edited down below what has already been paid against it: `422 installment_amount_below_paid`.

**5. Overpaying an upcoming (not-yet-due) cuota is credit, not an error.** Consistent with ADR-224 #2, an allocation against a future cuota reduces that cuota's (and the item's) outstanding, which may go negative exactly as a flat item's outstanding can. `upcomingTotal`, however, is never allowed to go negative — it floors at zero so the informational "upcoming" total never reads as a debt-in-reverse. The outstanding-only PDF (ADR-212) adds an explicit "Saldo a favor / Credit in your favor" line so the balance column still reconciles to the hero total.

**6. Suggested allocation is capped.** `GET /people/{id}/suggested-allocation` (ADR-224 #3) returns `max(0, outstanding)` — never a negative suggestion even if outstanding is already negative from an overpayment/credit.

**7. Over-split warning baseline for linked card cuotas.** ADR-218's non-blocking over-sum warning compares the sum of items linked to an expense against the expense's own total. When the linked expense is itself a card cuota (one month of an N-installment card purchase), the correct baseline is the *full plan total* — `amount × installments_total` — not the single cuota's amount, otherwise splitting a multi-month card purchase across people trips a false-positive warning every month. This plan total is exposed to the client as `planTotal`.

**8. Date bounds.** Item and cuota date fields (purchase date, due dates) are bounded to `2000-01-01..2100-12-31`; values outside that range return `422`.

**9. Payment-form UX guards.** The payment-recording form blocks Save until the received amount exactly equals the sum of the user's allocations — the user must take an explicit action (allocate the remainder, or open the overpayment-confirmation path) rather than silently under- or over-allocating by leaving the form partially filled. Confirming a matched income (ADR-207) for less than the income's own amount requires an explicit acknowledgement step before saving.

## Alternatives Considered

- **Optimistic concurrency (`version_id_col` + `409` on conflict) instead of pessimistic per-person lock**: avoids holding a row lock across the request, but pushes retry UX onto the client for what is, in practice, a single-user app with low write concurrency — rejected in favor of the simpler pessimistic lock.
- **Raise on Σcuotas ≠ item.amount mismatches**: more strictly correct, but turns one bad historical row into a hard failure for the whole Owed tab — rejected in favor of log-and-derive.
- **Create-then-PATCH cuotas as two requests**: matches the general REST create pattern, but is not atomic — a retried create could PATCH the wrong item's cuotas, or a dropped response could cause a client to duplicate the item — rejected in favor of one idempotent, atomic create call.
- **Keep allocation validation at the person level only (no per-target cap)**: was the status quo per ADR-206; review found it insufficient because a single allocation could overshoot its own item/cuota remainder while the person-level sum still looked fine — rejected, cap added.
- **Let `upcomingTotal` go negative like outstanding does**: technically consistent with treating future cuotas symmetrically, but reads as nonsensical ("upcoming: -$50") to the owner — rejected, floored at zero instead.

## Consequences

- Every receivables write path now opens with a `SELECT person FOR UPDATE`; this serializes writes per person and must be kept in mind for future endpoints added to this feature (they need the same lock-first pattern).
- Item create is the one place in the receivables API where the client supplies the id; this is a narrow, explicitly scoped exception to ADR-026 and must not be read as license to accept client-supplied ids elsewhere.
- The per-target cap is an additional confirm-time check layered on ADR-206's person-level check; `allowOverpayment` now needs to bypass both.
- `planTotal` becomes part of the over-split warning contract (ADR-218) wherever the linked expense is a card cuota; relates to the card-cuota expense model.
- The PDF template (ADR-209/211/212/222) gains a conditional "credit in your favor" row.
- In the web UI, a negative balance (person, item, plan or cuota) now renders as "Credit ARS X" / "Saldo a favor ARS X" instead of ADR-206's red minus-signed amount, consistent with the PDF credit row.
- Relates to ADR-026 (id-generation deviation, scoped), ADR-206 (person-level overpayment check this adds a per-target layer to), ADR-215 (due-only outstanding and upcoming total this clarifies the floor-at-zero rule for), ADR-218 (over-split warning baseline this refines for card-cuota-linked expenses), ADR-224 (guard refinements this extends with locking and idempotency rules).

**Deferred / open items (not decided here):**
- "Today" stays UTC at the request boundary (per ADR-224 #4), consistent with the rest of the backend; an Argentina-local "today" is a cross-app concern (affects more than receivables) and is deferred to a future, broader ADR.
- There is still no delete-payment endpoint (tracked since ADR-224 #1); until one exists, a plan with any allocation remains permanently reshape-locked unless the item itself is deleted.
- The two-people-confirming-the-same-income race (point 1's residual gap) is noted but not fixed here.

## Status History

- 2026-11-06: accepted
