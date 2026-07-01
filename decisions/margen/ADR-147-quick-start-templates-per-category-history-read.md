---
project: margen
adr: 147
title: Quick-start budget templates and per-category history read endpoint
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-147: Quick-start budget templates and per-category history read endpoint

## Context

First-time users of the Budgets page face a blank slate: no targets set means the zero-based allocation bar (ADR-145) starts empty, and users must manually enter every category target. History-backed templates are the biggest onboarding accelerator identified in the owner's design comp. The existing category-expense aggregation over prior months provides the raw data; no new write surface is needed because templates simply bulk-fill the existing per-category PUT endpoint. The 50/30/20 Savings leg reuses `POST /budgets/apply-profile` (ADR-138). All history reads are user-scoped (ADR-108/ADR-130).

## Decision

**Four quick-start templates:**

| Template | Logic |
|---|---|
| **50/30/20** | Needs pool = 50% of income distributed across essential categories weighted by 3-month average spend; Wants pool = 30% distributed across non-essential categories weighted by 3-month average spend; Savings leg = the matching saving profile (20% → Conservative preset, ADR-138) applied via `POST /budgets/apply-profile`. |
| **Match 3-mo avg** | Each category target = that category's trailing 3-month average spend (`avg3mo` from the history endpoint). |
| **Match last month** | Each category target = last month's actual spend (`lastMonth` from the history endpoint). |
| **Clear all** | Sets all category targets to zero. |

**Per-category "use avg" suggestion chips:**

- Appear on untargeted category rows (target = 0 or null).
- Pre-fill the inline target with `avg3mo` on click.
- Powered by the same history endpoint.

**History endpoint:**

- `GET /budgets/history?month=YYYY-MM` — read-only, user-scoped (ADR-108/ADR-130).
- Returns per-category `{ avg3mo: Decimal string, lastMonth: Decimal string }`.
- Computed by reusing the existing category-expense aggregation over the three months prior to `month`.
- No new table, no migration, no write surface.

**Template application mechanics:**

- Templates apply by issuing the existing per-category PUT writes batched client-side.
- The 50/30/20 Savings leg reuses `POST /budgets/apply-profile` (ADR-138); no new write endpoint.
- Batch writes are fire-and-forget in sequence; no transaction wrapper needed (idempotent PUT per category).

## Alternatives Considered

- **Backend-applied templates (single endpoint)**: `POST /budgets/apply-template` that bulk-writes all targets server-side — why not chosen: adds a write surface and test surface with no data-model benefit; batching the existing PUT calls client-side achieves the same result and keeps the backend surface minimal.
- **Storing historical averages in a materialised view**: pre-aggregate `avg3mo` nightly — why not chosen: query-time aggregation over three months of rows is fast enough; a materialised view adds refresh complexity with no correctness benefit.
- **Exposing more template presets (e.g., 70/20/10)**: ship multiple ratio presets — why not chosen: the owner explicitly chose 50/30/20 as the single ratio preset; additional presets are deferred; the architecture (income × ratio → weighted distribution) is generic enough to add them later.

## Consequences

- One additive read endpoint (`GET /budgets/history`); no new write endpoints; no schema change; no migration.
- The 50/30/20 template's weighting requires `avg3mo` per category; users with fewer than three months of history receive a proportional average over available months (partial average, not zero).
- The Conservative saving profile (20%, ADR-138) is the Savings leg of 50/30/20; the profile mapping (20% → conservative) is a code constant, not a configurable rule.
- Template actions are user-visible and reversible (Clear all or manual edits); no silent mutations (consistent with ADR-044 / ADR-137 "nothing silent" stance).
- Relates to ADR-108 (user-scoped reads), ADR-125 (per-category PUT is the existing write surface), ADR-130 (ownership enforcement on new aggregates), ADR-138 (apply-profile reused for Savings leg), ADR-145 (templates populate targets that drive the allocation bar), ADR-146 (Needs/Wants weighting follows the `isEssential` split).

## Status History

- 2026-06-30: accepted
