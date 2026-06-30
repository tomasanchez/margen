---
project: margen
adr: 145
title: Budgets UX — zero-based "assign every peso a job" allocation surface
category: ux
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-145: Budgets UX — zero-based "assign every peso a job" allocation surface

## Context

The MVP Budgets page shipped as a flat per-category target list with a separate income header and a separate savings section (ADR-125, ADR-138, ADR-139). The owner's design comp reframed the page around zero-based / envelope budgeting. The prior layout felt disconnected ("clunky"): income, spending targets, and savings lived in isolation rather than as parts of one coherent allocation. The PFM repositioning (ADR-119) positions Margen as an Excel/YNAB-lite replacement; zero-based budgeting makes every peso accountable and aligns with that positioning.

## Decision

The Budgets page is redesigned as a **zero-based allocation surface**. The existing net-income base (ADR-139) is the driver; the page never changes the underlying data model — this is a pure presentation and derivation layer over existing endpoints.

**"Spendable income" hero:**

- Displays the net-income figure from ADR-139 as the single source of allocatable funds.
- Below it, a stacked **Needs / Wants / Savings** allocation bar shows each group's share of income visually.
- A live readout shows one of three states: **"left to assign"** (income − Σ targets > 0), **"over-assigned"** (income − Σ targets < 0), or **"all assigned"** (= 0).

**"This month vs plan" band:**

- Displays Budgeted / Spent / Remaining aggregates for the current month.
- Includes a plain-language **insight line** derived client-side from spent-vs-target, e.g. "You're ARS X over plan — Shopping alone is ARS Y over its target."
- The insight is computed entirely on the frontend from the existing aggregates; no new backend endpoint.

**Category cards:**

- Categories are rendered as grouped cards: **Needs**, **Wants**, **Savings** (see ADR-146 for the grouping logic).
- Each group card shows a group total, % of income, and a progress bar.
- Each category row keeps the existing inline-editable target field and a spent-vs-target meter.

## Alternatives Considered

- **Keep the flat list**: retain the ADR-125 layout, add the insight line without restructuring — why not chosen: the allocation bar and zero-based readout require a grouped structure; patching the flat list would produce the same disconnected feel the owner rejected.
- **Full YNAB-style envelope moves**: let users move money between envelopes mid-month — why not chosen: out of scope for MVP; the zero-based framing is achieved through the allocation bar without requiring envelope-transfer mechanics.

## Consequences

- No data-model change; no new write endpoints; no migration.
- The "left to assign / over-assigned / all assigned" state is computed as `income − Σ targets` on the frontend, reusing the same category-target values already stored.
- The insight line is a client-side derivation; its wording is surfaced in the i18n catalog (ADR-100) under the `budgets` namespace.
- Category grouping depends on ADR-146 (Needs/Wants from `isEssential`; Savings from saving profiles).
- Relates to ADR-119 (PFM repositioning — YNAB-lite framing), ADR-125 (existing per-category targets reused), ADR-138 (Savings group = saving profiles), ADR-139 (net-income base is the hero figure), ADR-146 (grouping logic), ADR-147 (quick-start templates populate targets that feed the allocation bar).

## Status History

- 2026-06-30: accepted
