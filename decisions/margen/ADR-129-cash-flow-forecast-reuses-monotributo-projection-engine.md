---
project: margen
adr: 129
title: Cash-flow forecasting reuses the monotributo projection engine
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-129: Cash-flow forecasting reuses the monotributo projection engine

## Context

Cash-flow forecasting is the fourth slice of the PFM MVP (ADR-119). The monotributo module already includes a trailing-12-month linear projector (ADR-046) that computes a pace/average-based forward estimate. Building a separate general forecasting engine from scratch would duplicate this logic.

## Decision

Generalize the existing monotributo projection engine for general cash-flow forecasting: coarse, pace/average-based estimates using trailing transaction history. This becomes the first version of the forecasting feature.

A recurring-schedule-driven projector (one that respects due dates, subscription cycles, and committed future expenses) is a later enhancement once scheduling data exists in the ledger.

## Alternatives Considered

- **Build a recurring-schedule projector now**: Requires scheduling/recurring data that the ledger does not currently model — rejected; the foundation must come first.

## Consequences

- Fast, coarse forecast reusing existing logic — low implementation risk.
- Recurrence scheduling remains future work; the forecast will be approximate and pace-based only.
- The generalized engine must be extracted from the monotributo domain module into a shared service or the forecasting bounded context.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
