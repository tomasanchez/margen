---
project: margen
adr: 221
title: "Payment allocation and pardon target cuotas for installment items (amends ADR-206/210)"
category: business
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-221: Payment allocation and pardon target cuotas for installment items (amends ADR-206/210)

## Context

ADR-206 allocates payments against a `receivable_item` as the atomic settlement unit, and ADR-210 pardons a whole item. Installment items (ADR-214) need finer granularity: a payment should be able to settle one specific cuota, and a pardon should be able to forgive a single cuota or the whole remaining plan, while non-installment items keep working exactly as before.

## Decision

For installment items, allocation and pardon targets are cuotas (`receivable_installment` rows), not the item as a whole; non-installment items continue targeting the item directly, unchanged from ADR-206/210. Default auto-allocation of a new payment fills due, unpaid cuotas oldest-first (lowest index / earliest `due_on` first) up to the payment amount; the user can edit the resulting allocation manually, the same override path established by ADR-206. Pardon (ADR-210) extends to target either a single cuota (forgives just that due) or the whole remaining plan (forgives all unpaid, unallocated cuotas at once) — both reversible per-row or per-plan, like the existing item-level toggle.

## Alternatives Considered

- **Keep allocation/pardon only at the item level, ignore cuota granularity**: loses the "which specific cuota got paid/forgiven" traceability the PDF (ADR-222) needs — rejected.
- **Require the user to manually pick every cuota on every payment, no default**: correct but adds friction for the common case of paying the next due cuota(s) in order — rejected as the default, kept as the manual-edit escape hatch.

## Consequences

- `receivable_allocation` gains a nullable `installment_id`, required if and only if the target item has a schedule — a mixed-mode invariant flagged as a migration risk in ADR-223.
- The pardon toggle UI gains a cuota-vs-whole-plan choice when operating on an installment item.
- The oldest-first auto-allocation algorithm runs server-side at payment-confirm time.
- Amends ADR-206 (allocation target) and ADR-210 (pardon target) for installment items specifically; non-installment items are unaffected.
- Relates to ADR-214 (schema), ADR-215 (outstanding formula this allocates against), ADR-216 (schedule being allocated/pardoned), ADR-222 (PDF rendering of per-cuota status).

## Status History

- 2026-11-06: accepted
