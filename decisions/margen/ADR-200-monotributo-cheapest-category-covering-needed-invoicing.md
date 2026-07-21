---
project: margen
adr: 200
title: Monotributo page recommends the cheapest category that covers the user's needed invoicing
category: ux
date: 2026-07-21
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-200: Monotributo page recommends the cheapest category that covers the user's needed invoicing

## Context

The Monotributo page shows the A-K scale (ADR-067) with each category's annual income ceiling and monthly cuota, and it shows the user's own trailing-12-month standing against their *current* category (ADR-046). Neither view answers the question the owner actually has: **which category should I be in?**

The scale table is a static reference; the standing card describes where the user already sits. There is no cost-vs-benefit framing — cost being the tax (the category's cuota), benefit being the ability to invoice enough to legitimately cover real spending. Without this, the user has to eyeball the ceiling column against their own expenses manually.

## Decision

Add a **recommendation** to the Monotributo page: the **cheapest (smallest) category whose annual income ceiling ≥ the user's needed annual invoicing**.

**Needed annual invoicing** = trailing-3-month average expenses × 12, where the trailing-3-month average is:

- **Net of reimbursements** — reimbursement inflows (ADR-158) are not expenses and must not inflate the figure; the existing expense aggregation already excludes `kind='reimbursement'` by construction (only `kind='expense'` is summed), so no new filter is introduced.
- **ARS-equivalent** — expenses in USD are converted at their persisted FX snapshot before averaging (ADR-025 money convention; ARS-equivalent `amount` is the authoritative magnitude).

The lookup reuses `smallest_category_for` (ADR-046 / ADR-067) with `needed_annual_invoicing` as the amount, resolved against the scale vintage in effect on the page's reference date (`as_of=reference`). The whole Monotributo page runs on ONE clock: the standing meter, the projection, this recommendation **and** the A-K reference table all resolve `as_of=reference`, so they never show two different ceilings for the same category. Until a vintage's `effective_from` the page stays on the prior vintage (e.g. the 2026-02 scale through Jul 2026) and auto-switches on that date (the 2026-08 scale on Aug 1 2026). (An earlier draft specified `as_of=None`/latest for the recommendation; that was corrected to `as_of=reference` to keep the page self-consistent — a future vintage must not surface before its effective date.)

Displayed alongside the recommendation:

- The recommended category's letter, monthly cuota, and annual cuota (services or goods per the taxpayer's activity type, ADR-046).
- The **effective tax rate** = annual cuota ÷ needed annual invoicing, expressed as a percentage — this is the cost-vs-benefit number the owner asked for.
- The recommended row is **highlighted** in the existing A-K scale table (no new table; an annotation on the existing one).

**Edge cases:**

- **No expense history** (trailing-3-month average is undefined/zero): show no recommendation — a calm note (e.g., "not enough history yet"), consistent with the low-confidence handling pattern already used for the projected-category estimate (ADR-046, ADR-051).
- **Needed invoicing exceeds category K's ceiling**: no in-scale recommendation; show a calm flag such as "beyond Monotributo, consider régimen general" rather than forcing a category.

**This is planning guidance, not the legal category.** The real Monotributo category is legally determined by actual trailing-12-month invoiced income (ADR-046's `used`/projected calculation), not chosen freely. The recommendation answers "to cover your expenses, you'd need to invoice at least category X" — it is advisory sizing, displayed distinctly from the standing/projection card so the two are not confused.

**Scope:** additive only. A new nullable `recommendation` field on the existing Monotributo read model/endpoint response (ADR-047's reader pattern) — no new route — plus a UI block on the existing Monotributo page. No schema change, no migration.

## Alternatives Considered

- **Pure ratio ranking (best cuota-to-ceiling ratio across all categories)**: mathematically the "most efficient" category in the abstract, but ignores whether that category actually covers the user's real spending — could recommend a category too small to invoice their needs. Not chosen; the owner wants "covers my needs, cheapest that does" not "best ratio in isolation."
- **Passive "where you land" view (just show which category the user's current spending falls into, no explicit recommendation)**: this is close to what the standing card already does with `used`/projection (ADR-046); doesn't add the missing cost-vs-benefit framing the owner asked for. Not chosen.
- **6-month trailing average for needed invoicing**: smoother, less reactive to one noisy month, but the existing budgets feature already uses a 3-month average (`avg3mo`) for similar planning-guidance purposes; reusing that window keeps the app's "recent typical spending" concept consistent and the recommendation more responsive to actual life changes. Not chosen.
- **Tax-grossed-up needed-invoicing figure (invoicing target that nets out the category's own cuota, i.e., solve for the invoicing level whose net-of-tax proceeds equal expenses)**: more precise cost-vs-benefit modeling but materially more complex to compute and explain on a page that must stay calm and legible; the owner explicitly chose the simpler ceiling-covers-spending framing. Not chosen for MVP; could be revisited later as a refinement.

## Consequences

- The Monotributo page answers "which category should I be in" directly, framed as cost (cuota) vs. benefit (invoicing capacity), alongside the existing "where do I actually stand" (ADR-046) and the static scale reference (ADR-067).
- The recommendation is explicitly advisory — copy must distinguish it from the legally-determined actual category to avoid the user thinking the app is telling them what category they're "in."
- Reuses `smallest_category_for` (ADR-046/ADR-067) and the existing services/goods cuota split (ADR-046) — no new category-matching logic is introduced.
- Depends on accurate reimbursement exclusion (ADR-158) and ARS-equivalent normalization (ADR-025) already being correct in the expense aggregation the 3-month average draws from; this ADR does not change that aggregation, only reads from it.
- No backend schema/migration; the read model gains one nullable field, keeping this a additive, low-risk slice consistent with the MVP scope boundaries in ADR-051.
- Future refinement candidates (not committed here): tax-grossed-up invoicing target, configurable averaging window, goods-vs-services activity-type auto-detection.

## Status History

- 2026-07-21: accepted
