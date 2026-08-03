---
project: margen
adr: 201
title: Budgets carry forward last month's exact targets, auto-seeded by default
category: ux
date: 2026-08-03
status: accepted
supersedes: ADR-147
authors: [Tomas Sanchez]
---

# ADR-201: Budgets carry forward last month's exact targets, auto-seeded by default

## Context

ADR-147 shipped four quick-start templates, two of which were spend-based: "Match 3-mo avg" (`avg3mo`) and "Match last month" (`lastMonth`), both seeding category targets from **past spend** via the history endpoint. Neither reused the budget the user actually **set** — there was no way to say "just reuse last month's plan." A new month opened with empty targets and the zero-based allocation bar (ADR-145) at zero; the only rollover mechanic was the manual reprice-with-inflation prompt (ADR-137), which requires an explicit confirm action every time.

The owner wants the exact prior-month budget carried forward, and wants it to be the **default** behavior rather than a template the user has to notice and click.

## Decision

1. **Replace both spend-based templates with one: "Copy last month's budget."** It copies the prior month's actual per-category **targets** verbatim — no inflation, no averaging, no spend data involved. Sourced from the already-fetched prior budget period (no new read).

2. **Auto-fill by default.** When the viewed month has no targets and the prior month has targets, the exact copy is auto-seeded (writing via the existing per-category upsert batch, per ADR-147's batching mechanics), guarded so it:
   - (a) only runs when the current month is **fully empty** (no partial-seed clobbering of in-progress edits);
   - (b) only applies to the **current-or-future** month — never silently populates a past browsed month;
   - (c) runs **once per month** (no re-seed loop on repeat visits/re-renders);
   - (d) runs only **after both** the current and prior budgets have loaded (avoids seeding against a still-loading, falsely-empty prior period).

   A calm inline note tells the user the month was seeded from last month; they can edit any row or hit **Clear** (existing ADR-147 action) to blank it out. This is a visible, reversible side-effect — consistent with the "nothing silent" stance (ADR-044/ADR-137) in that it's disclosed and undoable, even though it's not confirm-gated like reprice.

3. **Reprice-with-inflation (ADR-137) remains available as an explicit, opt-in adjust action** — not the default anymore. A user who wants inflation-adjusted targets instead of an exact copy chooses that action explicitly; the rollover default is now the exact copy.

## Alternatives Considered

- **Keep spend-based templates ("Match avg" / "Match last month") alongside a new copy-budget option**: rejected — they conflated "what I spent" with "what I budgeted," which is exactly the confusion the owner wants to eliminate. Both are removed, not just deprioritized.
- **Inflation-adjusted rollover as the default (i.e., keep ADR-137's reprice as the automatic behavior)**: rejected — the owner wants a true "same budget" carried forward, not a recalculated one; reprice requires per-category judgment calls (step-ups, frozen contracts) that shouldn't happen silently on every rollover.
- **One-tap "Copy last month" button instead of auto-fill**: considered as the lower-risk option (fully explicit, no auto-write). Rejected — the owner explicitly wants the default state of a new month to already be the prior plan, not a state requiring one more click every month.
- **Auto-fill unconditionally (including past months, partial months, or repeated visits)**: rejected — would risk silently overwriting a past browsed month's history or clobbering in-progress edits on repeat visits; the four guards (empty-only, current-or-future-only, once-per-month, both-periods-loaded) exist specifically to prevent this.

## Consequences

- A new month starts pre-populated with last month's plan, ready to tweak, instead of opening at zero on the allocation bar (ADR-145).
- The spend-based seed signal ("what did I actually spend last month / on average") is no longer available as a bulk template. If the per-row "use avg" suggestion chip from ADR-147 is retained, that remains the way to see spend history per category; this ADR does not remove the chip, only the two bulk spend-based templates. If the chip is also removed, that is a separate, explicit follow-up decision.
- The auto-fill is a write that happens on first view of an empty current/future month without an explicit user click — a deliberate, disclosed, reversible (via Clear) exception to the strict confirm-before-write pattern used elsewhere (ADR-137's reprice, ADR-044's suggest/confirm). This exception is scoped narrowly by the four guards in the Decision section.
- Reprice-with-inflation (ADR-137) is demoted from "the rollover mechanism" to "an opt-in adjustment on top of the copied budget" — ADR-137's confirm-on-rollover UI and `reprice_cap` function are unchanged; only its role as the default path is refined.
- No schema change; reuses the existing per-category PUT/upsert batch (ADR-147) and the existing prior-period budget fetch — no new write endpoint, no new read endpoint.
- Relates to ADR-145 (targets populate the zero-based allocation bar), ADR-147 (superseded: its two spend-based templates removed; its batching mechanics and per-category history endpoint reused), ADR-137 (refined: reprice becomes the opt-in adjust action, no longer the default rollover), ADR-141 (unaffected — reprice's manual inflation input is untouched, just less frequently the first thing a user reaches for).

## Status History

- 2026-08-03: accepted
