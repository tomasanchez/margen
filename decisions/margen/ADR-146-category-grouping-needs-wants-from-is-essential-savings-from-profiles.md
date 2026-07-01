---
project: margen
adr: 146
title: Category grouping — Needs/Wants derived from is_essential; Savings group = existing saving profiles
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-146: Category grouping — Needs/Wants derived from is_essential; Savings group = existing saving profiles

## Context

ADR-145 introduces a Needs / Wants / Savings three-group layout for the Budgets page. The grouping logic must be derived from existing domain constants rather than introducing a parallel classification. Two sources already encode the required information: the `ESSENTIAL_CATEGORIES` / `is_essential` flag (ADR-140/ADR-143) for the Needs/Wants split, and the saving profiles (ADR-138) for the Savings group. Duplicating the essentials list on the frontend would introduce drift; the Savings group is already a first-class aggregate (ADR-142) with conservative/balanced/aggressive presets.

## Decision

**Needs/Wants split:**

- **Needs** = expense categories where `is_essential` is `true` (the `ESSENTIAL_CATEGORIES` constant, ADR-140).
- **Wants** = all other expense categories (`is_essential` is `false`).
- The backend stamps an `isEssential` boolean on each category line in the budgets read model. The frontend groups solely by this field; the essentials list is never duplicated client-side.
- This additive field on the read model requires no schema migration (no new column; it is derived at query time from the existing `ESSENTIAL_CATEGORIES` constant).

**Savings group:**

- The Savings group in the allocation surface IS the saving profiles/buckets already built (ADR-138): conservative (20%), balanced (30%), aggressive (40%).
- The saving profile selected by the user is the Savings allocation; its buckets are NOT replaced by the new layout.
- The household floor (ADR-143) maps conceptually to the Needs total; `income_pressure` and `suggest_strategy` are retained as-is.

## Alternatives Considered

- **Frontend-owned essentials list**: maintain a second copy of `ESSENTIAL_CATEGORIES` in the frontend bundle — why not chosen: any change to the backend constant would silently desync the grouping; one source of truth is mandatory.
- **New "group" field on categories**: add a `group` enum (`needs | wants | savings`) column to the category table — why not chosen: unnecessary schema change; `is_essential` already encodes the Needs/Wants split, and savings are not expense categories.
- **Separate Savings section independent of profiles**: treat Savings as a simple percentage target field — why not chosen: contradicts ADR-138 and ADR-142; the profile presets + buckets are the established savings aggregate and must not be duplicated.

## Consequences

- A small additive `isEssential: bool` field is added to the budgets category read model (no migration, derived at query time).
- The Savings group in the UI renders the active saving profile and its buckets; `POST /budgets/apply-profile` (ADR-138) remains the write surface for Savings.
- The household floor readout (ADR-143) aligns conceptually with the Needs group total; the `income_pressure` suggestion can reference the Needs allocation bar.
- No contradiction with ADR-138, ADR-140, ADR-143; this ADR is purely additive.
- Relates to ADR-138 (saving profiles = the Savings group), ADR-140 (`ESSENTIAL_CATEGORIES` is the one source of truth), ADR-142 (savings buckets remain first-class), ADR-143 (household floor maps to Needs total), ADR-145 (the three-group layout that consumes this grouping).

## Status History

- 2026-06-30: accepted
