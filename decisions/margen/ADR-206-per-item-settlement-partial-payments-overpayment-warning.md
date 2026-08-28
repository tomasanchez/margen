---
project: margen
adr: 206
title: Per-item settlement with partial payments; overpayment warns
category: business
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-206: Per-item settlement with partial payments; overpayment warns

## Context

A person may owe the owner across several itemized debts (ADR-204) and pay them back gradually or all at once, sometimes in an amount that doesn't cleanly match any single item. The feature needs settlement rules that (a) support partial paybacks per item, (b) preserve the item-level justification the owner recorded, and (c) guard against a user accidentally over-allocating a payment beyond what a person actually owes.

## Decision

Payments (recorded manually, or from a confirmed income match per ADR-207) are allocated to specific `receivable_item`s via `receivable_allocation` (ADR-204). Partial allocations are allowed — an item can be paid down across multiple payments, and a single payment can be split across multiple items. A person's outstanding balance = Σ of each item's remainder (`item.amount` − Σ its allocations).

If a payment/allocation would cause the total allocated to a person to exceed that person's current outstanding balance, the UI surfaces a **confirm-time WARNING** before saving — the user can either cap the allocation to the outstanding amount or explicitly proceed anyway (e.g., to record a genuine future credit). The system never silently clamps the amount and never silently allows the outstanding balance to go negative without the user having seen and acknowledged the warning.

## Alternatives Considered

- **Per-item boolean `settled` flag instead of allocations**: simplest to implement, but cannot represent a partial payback against a single item — rejected.
- **Per-person running balance detached from items** (a single ledger number per person, no item linkage): loses the item ↔ payment traceability the per-person PDF (ADR-209) needs to justify the total — rejected.
- **Silent clamp to outstanding, or silently allow negative outstanding**: both are surprising behavior for money the user is actively trying to track accurately; a silent clamp hides a possible data-entry mistake, and silent negative outstanding is confusing without confirmation — rejected in favor of an explicit warn-and-choose step.

## Consequences

- Richest settlement UX: supports the real-world case of a single payback covering several debts, or several paybacks slowly covering one debt.
- Requires allocation-total validation at confirm time (sum of a payment's allocations must not exceed the payment's own amount; sum of allocations against a person must not silently exceed outstanding without the warning path).
- The overpayment warning is a UI/app-layer guard, not a hard DB constraint — an explicit user override remains possible for edge cases (e.g., recording a good-faith overpayment as a running credit).
- Relates to ADR-204 (schema this operates on), ADR-207 (matched-income payments feed into the same allocation flow), ADR-209 (the PDF surfaces the resulting per-item outstanding).

## Status History

- 2026-08-28: accepted
