---
project: margen
adr: 216
title: "Cuota schedule creation: even split with rounding; per-cuota edits; N locked once allocated"
category: data
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-216: Cuota schedule creation: even split with rounding; per-cuota edits; N locked once allocated

## Context

ADR-214 allows a `receivable_item` to carry a cuota schedule. The app needs concrete rules for how a schedule is created and later edited, including the common real-world wrinkle of interest/recargo changing a later cuota's amount, and the risk of editing the cuota count after payments have already been allocated against specific cuotas.

## Decision

Creating a schedule: the user enters the item's total amount, the number of cuotas (N), and the first due month. Due dates are generated monthly from that start. The total is split evenly across N cuotas, with any rounding remainder (cents) reconciled onto the last cuota so the schedule sum always exactly equals the item total.

Editing a schedule: any single cuota's amount and/or due date can be edited afterward (e.g. to reflect interest or a recargo applied by the lender/card). The parent item's `amount` is re-derived as the sum of its cuotas' amounts after such an edit — it is never entered independently once a schedule exists.

Changing N (adding or removing cuotas) on a plan that already has allocations is **blocked**: the user must remove the existing allocations first. Early payoff is not a special state — it's an ordinary payment whose allocation happens to cover all remaining cuotas at once.

## Alternatives Considered

- **Enter each cuota's amount manually, no default split**: more flexible from the start, but adds friction for the common even-split case with no demonstrated need — rejected.
- **Non-editable even split (no per-cuota edits)**: simpler state, but cannot represent interest/recargo added after the fact, a real scenario the owner wants to capture — rejected.

## Consequences

- Validation: `sum(cuota.amount) == item.amount` is enforced on every schedule edit.
- N-change is blocked at the app layer via an allocation-existence check on the plan before allowing add/remove of cuota rows.
- No special-case "payoff" code path — a full-covering payment/allocation (ADR-221) naturally zeroes out all remaining cuotas.
- Relates to ADR-214 (schema this creates/edits), ADR-221 (allocation targeting the cuotas produced here).

## Status History

- 2026-11-06: accepted
