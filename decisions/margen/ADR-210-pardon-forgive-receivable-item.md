---
project: margen
adr: 210
title: "Pardon (forgive) a receivable item; distinct from delete"
category: data
date: 2026-08-29
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-210: Pardon (forgive) a receivable item; distinct from delete

## Context

The owner sometimes chooses to forgive a debt — covering it for the person out of pocket rather than collecting it — and wants that recorded and **visible on the PDF** (ADR-209) as a record of goodwill, while the item no longer counts as owed. This is a distinct concept from **delete**, which means the item was a data-entry error and should be removed entirely: uncounted and not shown anywhere, including the PDF.

## Decision

1. A `receivable_item` (ADR-204) gains a nullable **`pardoned_at`** timestamp column; pardoned = non-null. Pardoning is **reversible** — un-pardon clears `pardoned_at` — implemented as a toggle, and is owner-scoped like all other item operations.
2. A pardoned item is **excluded from the person's outstanding**: outstanding = Σ remainders of non-pardoned items only (amends ADR-206's calculation). A pardoned item is also **not a valid payment/allocation target** — you cannot pay down something you've already forgiven. Any allocations an item already had before being pardoned (e.g., it was partially paid, then the remainder pardoned) remain untouched as historical fact.
3. The per-person **PDF** (ADR-209) gains a dedicated **"Covered by you"** section (es: "Cubierto por vos"), positioned **below** the section showing what the person still owes. It lists each pardoned item (date / amount / detail) and a **"You covered ARS X" total** (es: "Total cubierto"), where a pardoned item's covered amount = its remaining balance at the moment of pardon (item amount minus its allocations at that time). This is what makes the goodwill visible to the recipient. The section follows the same app-language, icon, and no-em-dash rules established by ADR-209's amendment.
4. **Delete** is unchanged: it remains the "this was an error" path — the item and its allocations are removed entirely and counted nowhere, including the PDF.

## Alternatives Considered

- **Model pardon as a full-value payment with `source='pardon'`**: reuses the existing payment/allocation machinery, but a payment implies cash actually received; a pardon is the opposite (forgiveness of cash never received), and forcing it through the payment model would muddy payment/allocation semantics and downstream reports — rejected.
- **Just delete forgiven items**: simplest, but loses the goodwill record the owner explicitly wants preserved and shown on the PDF — rejected.
- **Person-level "forgive all" only** (no per-item granularity): the owner asked to forgive specific items, not a person's entire balance; per-item is the correct unit and a future "forgive all" convenience action can compose on top of per-item pardons later — rejected as the primary mechanism.
- **Irreversible pardon**: simpler state model, but the owner explicitly wants to be able to undo a pardon (e.g., recorded in error, or the person ends up paying after all) — rejected in favor of a reversible toggle.

## Consequences

- One new nullable column on `receivable_item` (no new table); a small Alembic migration.
- Outstanding calculation and allocation-target queries must filter `pardoned_at IS NULL` everywhere they currently sum or list items (amends ADR-206).
- The PDF read/export surface must expose pardoned items separately, along with each one's covered amount, to populate the new "Covered by you" section (amends ADR-209).
- Net worth remains entirely unaffected — `receivable_item` still carries no `account_id` (ADR-205); pardoning is purely an in-feature state change.
- Historical allocations on a since-pardoned item are preserved and not altered or hidden — only the outstanding calculation and PDF placement change.
- Relates to ADR-204 (schema this column extends), ADR-206 (outstanding/settlement rules amended to exclude pardoned items), ADR-208 (UI needs a pardon/un-pardon toggle affordance), ADR-209 (PDF amended with the new "Covered by you" section).

## Status History

- 2026-08-29: accepted
