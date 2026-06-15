---
project: margen
adr: 088
title: Expose an optional Name/merchant field on the transaction form
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-088: Expose an optional Name/merchant field on the transaction form

## Context

The transaction domain has always carried a required `name` (ADR-024/027), but the
Add/Edit form never exposed it: a manually-created expense's `name` was auto-derived
from its **Category** (`deriveName` → e.g. "Food"), and the only free-text input
("More details") maps to `notes`. Per-line reconciliation (ADR-084/085) matches a
statement line against the existing transaction's **`name`** — so for hand-entered
expenses, whose `name` is just a category, the name condition can never match a
merchant like "SUSHI RECOLETA", and reconciliation would not fire for the very case
it targets (a duplicate the user logged manually mid-month).

## Decision

Add an **optional "Name"** input to the Add/Edit transaction form. When filled, it is
the transaction's `name` (e.g. "Sushiclub"), which the reconciliation matcher uses.
When left blank, behavior is unchanged: `name` falls back to the category-derived
label (`deriveName`), and such a row simply won't match by name (it can still match
on amount+date if a future rule allows, but that is out of scope here). A parsed
invoice (ADR-072) pre-fills the field with the extracted client name, still editable;
the Monotributo cuota autofill continues to set its configured label. `notes` ("More
details") remains separate and is **not** used for matching.

## Alternatives Considered

- **Match amount+date alone when the name is a bare category**: makes reconciliation
  fire without naming, but never lets the user influence the match and leaves the
  matcher's name logic dead for manual rows — not chosen (the user wants to name).
- **Match against `notes` too**: overloads a free-form field with matching semantics;
  ambiguous and surprising — not chosen.
- **Require a name on every transaction**: heavier; breaks the lean category-first
  capture flow for users who don't care to name an expense — not chosen (kept optional).

## Consequences

A small, optional field on an existing form; no backend or schema change (the `name`
field and its persistence already exist). Reconciliation becomes useful for manual
expenses the user chooses to name. Un-named expenses behave exactly as before. The
matcher (ADR-085) is unchanged — it already reads `name`.

Relates to: ADR-024/027 (transaction `name`), ADR-084/085 (reconciliation matches on
`name`), ADR-072 (invoice parse prefills name), ADR-080/086 (review/reconciler UX).

## Status History

- 2026-06-14: accepted
