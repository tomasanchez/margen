---
project: margen
adr: 083
title: Add an Entertainment category; map statement PASSLINE charges to it
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-083: Add an Entertainment category; map statement PASSLINE charges to it

## Context

The credit-card statement import (ADR-079) guesses a category per purchase. Event
tickets (e.g. `MERPAGO*PASSLINE` — parties/going out) had no fitting category: the
prototype set (ADR-027: Income, Food, Rent, Transport, Subscriptions, Health,
Shopping, Services, Taxes, Fee, Other) lacks a leisure/entertainment bucket, and
the parser was emitting an off-taxonomy `"Entertainment"` string the UI dropdown
did not even offer.

## Decision

Add **`Entertainment`** as a first-class category to the known set, covering
parties, events, cinema, shows, and similar going-out spending. It is registered
in all canonical places: the frontend `Category` union (`apps/web/src/mock/types.ts`),
the dropdown/filter seed list (`apps/web/src/mock/seed.ts`), and the backend
`KNOWN_CATEGORIES` set (`domain/models/value_objects.py`).

The statement parser's category guesser maps the `passline` keyword (Passline =
event ticketing) to `Entertainment`. The bare `merpago` keyword (Mercado Pago, a
generic payment processor) is **not** mapped — a `MERPAGO*<other>` charge is too
ambiguous to auto-categorize and stays uncategorized for the user to set at the
review step (ADR-080). Categories remain tolerant validated strings (ADR-027); the
guess is only a convenience and is always editable.

## Alternatives Considered

- **Reuse `Other`/`Shopping`**: Conflates leisure with miscellaneous/retail spend;
  defeats the per-category insight the import is meant to enable — not chosen.
- **Name it `Going out` / `Social` / `Nightlife`**: `Entertainment` is the broader
  one-word fit (events, cinema, shows), consistent with the single-word taxonomy —
  chosen by the user.
- **Also map bare `merpago`**: Would mis-tag unrelated Mercado Pago charges as
  Entertainment — not chosen.

## Consequences

One new category across three canonical lists and the parser's keyword map. The
category set stays a tolerant string set (ADR-027), so #6's future category
management can rename or reorganize it without a migration. PASSLINE rows now land
in a meaningful bucket; other Mercado Pago charges remain uncategorized by design.

Relates to: ADR-024/027 (transaction model, category as validated string, #6 owns
category management), ADR-079 (statement line → transaction mapping), ADR-080
(review-step editing).

## Status History

- 2026-06-14: accepted
