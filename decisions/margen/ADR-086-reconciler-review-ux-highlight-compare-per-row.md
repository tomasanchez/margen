---
project: margen
adr: 086
title: Reconciler Review UX — Highlight, Compare, Per-Row Resolution
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-086: Reconciler Review UX — Highlight, Compare, Per-Row Resolution

## Context

The review table (ADR-080) presents all parsed statement lines before the user confirms import. ADR-084 introduced flagged rows (likely duplicates). These rows need to be visually distinct, show enough information for the user to make a confident decision, and expose a resolution control — all without disrupting the calm, focused flow established in ADR-037.

## Decision

- **Visual highlight**: Flagged rows are marked with a non-color cue — a "Possible duplicate" chip or label — in addition to any background treatment. Color is never the sole differentiator (ADR-019 accessibility rule).
- **Inline match context**: Each flagged row shows the matched existing transaction inline: name · date · amount. This is sufficient for most decisions without opening a separate view.
- **Side-by-side comparison**: A flagged row offers an expandable panel or modal that places the statement line and the matched transaction side by side. The exact implementation (accordion vs. dialog) is a detail within this paradigm and may be decided during development.
- **Per-row resolution control**: Each flagged row exposes a selector with two choices — **Merge** (default) and **Keep both**. The default is Merge; the user must actively switch to Keep both to import as a separate charge.
- **Import summary**: The confirmation summary line reads "N new / M merged" so the user can see at a glance how many transactions will be created vs. enriched. Merged lines do not add to the "will import as new" count.
- **Unflagged rows**: Behave exactly as before (ADR-080) — no change to that path.

## Alternatives Considered

- **Color-only highlight**: Violates ADR-019 accessibility requirements — rejected; a chip/label is required.
- **Batch resolution (all flagged rows at once)**: Loses per-line granularity needed when only some matches are correct — rejected.
- **Separate reconciliation screen**: Adds a navigation step and breaks the single calm flow — rejected; inline resolution within the existing review table is preferred.

## Consequences

- The review table component gains a conditional flagged-row variant with additional UI elements; component complexity increases but the flow remains on one screen.
- The "Possible duplicate" chip must be keyboard-accessible and announced by screen readers (ADR-019).
- Design must ensure that a table with many flagged rows remains scannable; if needed, a "show only duplicates" filter may be added later without an ADR.
- Relates to ADR-080 (review table), ADR-019 (non-color cues, keyboard), ADR-037 (calm design), ADR-084 (reconciliation decision), ADR-085 (resolution semantics).

## Status History

- 2026-06-14: accepted
