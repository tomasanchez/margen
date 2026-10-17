---
project: margen
adr: 213
title: "Add a \"Mili\" expense category to track spending on the owner's partner"
category: data
date: 2026-10-17
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-213: Add a "Mili" expense category to track spending on the owner's partner

## Context

The owner's partner wants to see how much the owner spends on her. Today that spend is scattered across Social, Shopping, Entertainment, etc., so it cannot be totaled or budgeted. Categories are a closed, code-defined set (ADR-024/027) extended by small deltas (ADR-083, ADR-135, ADR-140 "Social").

## Decision

Add `Mili` to the known category set (backend `KNOWN_CATEGORIES`, frontend `Category` type, `CATEGORIES`, `EXPENSE_CATEGORIES`, en/es labels), following the ADR-140 "Social" precedent. It is discretionary: NOT in `ESSENTIAL_CATEGORIES`, so budgets group it under "Wants". The label is the same in both locales (a proper name). No schema change — `category` is a free string column.

## Alternatives Considered

- **User-defined custom categories**: the general solution, but a much larger feature (schema, CRUD, budgets, i18n) — deferred.
- **Tags / per-person attribution orthogonal to category**: would keep the real category (Food, Shopping) as well, but adds a new dimension across filters, reports and budgets — deferred.

## Consequences

- Spend on the partner becomes filterable, reportable and budgetable as its own line.
- Existing transactions are not recategorized automatically; the owner re-tags them manually if wanted.
- A person's name is hardcoded into the product's category set; if the app gains other users, this should migrate to custom categories.
