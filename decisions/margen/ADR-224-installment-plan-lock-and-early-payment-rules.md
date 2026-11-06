---
project: margen
adr: 224
title: "Installment plan lock, early-payment, default allocation order, and guard refinements (refines ADR-215/216/221)"
category: business
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-224: Installment plan lock, early-payment, default allocation order, and guard refinements (refines ADR-215/216/221)

## Context

Implementing ADR-214/215/216/221 surfaced several edge cases that needed concrete rules: ADR-216 blocks changing the cuota count (N) once allocations exist, but doesn't say what happens to pardons on reshape, nor what other edits should also be locked; ADR-215's due-only outstanding raises the question of what happens when a payment covers a cuota that isn't due yet; ADR-221 establishes oldest-first auto-allocation for installment cuotas but the full-person allocation order (across both installment and flat items) was undefined; and several error-handling and rounding/limit details were left open during implementation. This ADR refines (does not supersede) ADR-215, ADR-216, and ADR-221 with the rules actually implemented.

## Decision

**1. Plan lock scope.** A schedule is locked for reshaping once it has allocations *or* pardons against it (extends ADR-216's "N locked once allocated"). Reshaping — changing cuota count, changing the first due date, changing an installment item's total amount, or converting flat↔installments — returns `409 installment_schedule_locked` with a `reason` of `"allocations"` or `"pardons"`, because regenerating the even split would silently drop existing pardons and per-cuota edits. Per-cuota amount/due-date edits (ADR-216) remain allowed after payments — only reshape operations are blocked. Known gap: there is no delete-payment endpoint yet, so once a plan has any allocation its shape is permanently locked unless the item itself is deleted; a follow-up (delete-payment/unlock path) is tracked as future work.

**2. Paying ahead of due date.** Overpayment is measured against due-only outstanding (ADR-215). Allocating a payment to a cuota that isn't due yet therefore doesn't hit a hard error — it reduces due-only outstanding below what the raw payment amount would suggest and so can trip the existing ADR-206 overpayment-confirmation warning (`allowOverpayment=true` to proceed), same as any other overpayment. The UI wording for that warning is extended to explain "includes cuotas not yet due" so the user understands why an on-time-looking payment is flagged.

**3. Default allocation order.** `GET /people/{id}/suggested-allocation` orders candidates as: due cuotas first, oldest `due_on` first (ties broken by older purchase date, then item id, then cuota index), followed by open flat (non-installment) items newest-first (matching the existing client-side seed order). Upcoming (not-yet-due) cuotas are never suggested by default — only surfaced if the user manually opts to pay ahead (see #2).

**4. Guards and limits.**
- Linking a receivable item to a transaction that is missing, belongs to another user, or is not an expense returns a single `404` (mirrors the existing matched-income guard's error shape).
- Allocating a payment to a pardoned cuota returns `404` (mirrors the existing pardoned-item guard).
- An installment item itself never carries an item-level `pardoned_at` — pardoning "the item" for an installment plan means pardoning all remaining (unpaid, unallocated) cuotas, not setting a flag on the parent row.
- Cuota count (N) is capped to the range 2..120 inclusive.
- Cuota amounts and plan totals are rounded half-up to the nearest cent (consistent rounding direction for the ADR-216 remainder reconciliation).
- "Today", wherever due-only outstanding (ADR-215) or due-date comparisons are evaluated, is the UTC date injected at the request boundary — never read from server wall-clock inside domain/service code (continues the ADR-215 testability note, now stated as a general rule).

## Alternatives Considered

- **Allow reshape operations to silently regenerate the schedule, dropping existing pardons and per-cuota edits**: simpler implementation, no 409 path needed — rejected, this is silent data loss the owner would not notice until reconciling.
- **Hard-reject any allocation to a not-yet-due cuota**: avoids ambiguity about what "overpayment" means — rejected, friends and family do sometimes pay ahead of the due date and the app shouldn't block a real, friendly transaction; the existing overpayment-confirmation flow already handles "are you sure" cases well enough.

## Consequences

- The schedule-edit endpoint must check for both allocations and pardons before allowing a reshape, and return a structured `reason` field so the UI can explain *why* the plan is locked.
- The overpayment-warning copy (ADR-206 confirm dialog) needs an installment-aware variant mentioning not-yet-due cuotas.
- `suggested-allocation` is a cross-item ordering (installment cuotas + flat items), not just the per-plan oldest-first rule from ADR-221 — ADR-221's oldest-first rule is the installment-only subset of this broader order.
- Rounding and N-cap limits are now explicit validation rules rather than implicit; relevant to the migration/validation layer referenced as a risk in ADR-223.
- Relates to ADR-215 (due-only outstanding this refines the early-payment behavior of), ADR-216 (schedule lock this extends to pardons), ADR-221 (allocation/pardon targeting and default order this refines), ADR-223 (testability/"today" risk this formalizes as a rule).

## Status History

- 2026-11-06: accepted
