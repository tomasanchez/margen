---
project: margen
adr: 103
title: Localize backend-provided text client-side via key maps
category: data
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-103: Localize backend-provided text client-side via key maps

## Context

Some displayed text originates from the backend: category names and bank names
(enum-like finite strings) and Insights, which the backend returns as structured
facts (ADR-060/061) that the frontend renders. No backend i18n exists.

## Decision

Localize backend-provided text on the **frontend**: map the finite category/bank
enum keys to localized labels in the catalogs, and localize the Insights
presentation templates around the structured facts. No backend change. Unknown
or unmapped keys fall back to the raw value.

## Alternatives Considered

- **Leave backend text in English**: mixed-language UI; categories, banks, and
  insights are prominent on Home — not chosen.
- **Backend localization**: out of scope; a larger cross-cutting effort.
  Deferred to a future decision.

## Consequences

Catalogs gain category/bank/insight keys. A new backend string that is not
mapped renders in its raw (English) form until explicitly added — tracked as a
risk in ADR-106.

Relates to: ADR-060/061 (Insights structured facts that drive the frontend
presentation layer), ADR-100 (i18n business scope), ADR-106 (unmapped key risk
accepted here).

## Status History

- 2026-06-24: accepted
