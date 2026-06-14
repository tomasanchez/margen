---
project: margen
adr: 67
title: Versioned, effective-dated Monotributo scale registry
category: architecture
date: 2026-06-14
status: accepted
supersedes: ADR-048
authors: [Tomas Sanchez]
---

# ADR-067: Versioned, effective-dated Monotributo scale registry

## Context

ADR-048 shipped the A–K Monotributo scale as a single versioned backend constant representing the current table. ADR-051's 2026-02 refresh overwrote the prior values in place, meaning the old scale survives only in git history.

ARCA revises the scale each semester (approximately February and August, indexed to inflation). A single current-only constant has two concrete problems:

1. **Lost historical tables** — only git history retains prior scale values; there is no in-code record of what ceiling applied in, say, October 2025.
2. **Incorrect backfill ceilings** — the ADR-052 snapshot backfill calls `get_ceiling` (ADR-046) with the current scale. A past period that fell under an earlier scale is therefore evaluated with the wrong ceiling, which is slightly incorrect.

The team wants the historical scale preserved in code and the backfill to be date-correct.

## Decision

Replace the single current-only scale constant (ADR-048) with a versioned, **effective-dated registry**: an ordered in-code collection where each entry carries an `effective_from` date and the full immutable scale table for that ARCA vintage.

At minimum two vintages are seeded at migration time:

- **2025 second-semester** — effective approximately 2025-08-01, covering Aug 2025–Jan 2026.
- **2026 first-semester** — effective approximately 2026-02-01, covering Feb–Jul 2026.

The lookup functions `get_category` / `get_ceiling` / `smallest_category_for` (ADR-046) gain an optional `as_of: date` parameter. When supplied, the function selects the latest registry entry whose `effective_from` is ≤ `as_of`. When omitted, `as_of` defaults to the current server date, so all existing call sites and the live calculation continue to use the current scale unchanged — no call-site migration required.

The ADR-052 capture/backfill path passes each period's reference date as `as_of`, so a backfilled past-period snapshot uses the ceiling that applied to that period (correctness fix).

The registry stays an **in-code constant** (no DB table), consistent with ADR-048's rationale: the scale changes approximately twice a year; a versioned in-code structure avoids seed/migration churn and keeps changes reviewable in PRs. Money remains `Decimal` throughout (ADR-025).

Going forward, a new ARCA scale vintage is added by **appending** a new entry to the registry with its `effective_from` date. No existing entry is overwritten.

## Alternatives Considered

- **Keep a single current-only constant + rely on frozen snapshots (status quo)**: Frozen snapshots preserve computed figures but not the scale table itself, and the backfill keeps using today's ceiling for past months. The team wants the historical scale record and date-correct backfill. — not chosen.
- **Keep the prior scale as a dead documented constant (not used by logic)**: Preserves the historical record in code but does not fix the backfill-uses-today's-ceiling wrinkle. An effective-dated lookup is barely more code and is more correct. — not chosen.
- **Move the scale into a database table with effective dates**: ADR-048's reasoning still holds — the scale changes ~twice a year; an in-code versioned registry avoids seed/migration churn and keeps it reviewable in PRs. — not chosen.

## Consequences

- Full historical scale tables are preserved in code and selectable by date; the live calculation and endpoints are unchanged (`as_of` defaults to now).
- The ADR-052 backfill becomes date-correct: each past period uses the scale vintage in effect at the time, not the current one.
- Maintaining the scale now means **appending** a new vintage entry each semester (≈ Feb/Aug) rather than overwriting, so history accrues automatically.
- The date-selection logic (latest entry with `effective_from` ≤ `as_of`) requires its own unit tests; the 100% coverage gate (ADR-032) covers this path.
- **Amends ADR-048**: the single current-only constant becomes an effective-dated registry. ADR-048 is superseded by this record.
- **Refines ADR-052**: the backfill ceiling-selection now passes each period's date as `as_of` rather than relying on the current scale.
- Cross-reference: ADR-046 (`get_ceiling` / `smallest_category_for` — the functions extended with `as_of`); ADR-051 (scale staleness risk and the 2026-02 refresh note — the overwrite pattern documented there is now replaced by the append pattern); ADR-025 (Decimal money convention, unchanged).

## Status History

- 2026-06-14: accepted
