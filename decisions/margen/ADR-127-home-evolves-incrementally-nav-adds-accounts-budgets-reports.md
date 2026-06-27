---
project: margen
adr: 127
title: Home evolves incrementally; nav adds Accounts, Budgets, Reports
category: ux
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-127: Home evolves incrementally; nav adds Accounts, Budgets, Reports

## Context

Home is currently a monthly-status page with a month hero and category summaries (ADR-040, ADR-043). The PFM repositioning (ADR-119) adds net worth, budgets, reports, and forecasting. Navigation must surface new top-level sections without fragmenting information architecture or requiring a full Home redesign.

## Decision

Evolve Home incrementally: keep the existing month-status hero and append net-worth and budget progress cards below it. No configurable widget dashboard for MVP.

Navigation/IA changes:
- Add Accounts, Budgets, and Reports as top-level nav peers alongside the existing Transactions/Home entries.
- Demote Monotributo and Import to a secondary grouping (settings-gated and/or a "Tools" group) per ADR-126.

## Alternatives Considered

- **Configurable widget dashboard**: Allows users to arrange Home cards — large rebuild, requires layout state management and persistence — rejected for MVP.

## Consequences

- Incremental Home additions preserve the existing Home UX investment.
- Nav requires restructuring: new top-level items, monotributo/imports demoted.
- i18n keys required for new sections (Accounts, Budgets, Reports, net worth labels) per ADR-100/101.
- Future Home evolution (configurable widgets, goals card) is not blocked by this approach.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
