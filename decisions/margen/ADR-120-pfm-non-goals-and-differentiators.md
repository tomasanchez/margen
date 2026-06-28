---
project: margen
adr: 120
title: PFM non-goals and differentiators
category: business
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-120: PFM non-goals and differentiators

## Context

A general PFM risks becoming a generic clone of dozens of existing tools. Without explicit non-goals, scope creep toward commodity features (live bank sync, multi-user households) could dilute focus and delay delivery of the core value proposition.

## Decision

Explicit non-goals:

- **No live bank-sync / aggregation**: Entry is manual or via PDF statement/invoice import (existing import pipeline). No Plaid-style open-banking integration.
- **Household / multi-user**: Not adopted as a hard non-goal — left open for the future — but not part of the PFM MVP.

Differentiators:

- **AR-currency-native handling**: ARS/USD/MEP rate support (ADR-044) and display-currency transform (ADR-056) — no other mass-market PFM handles Argentine peso/dollar duality natively.
- **Monotributo niche hook**: The optional monotributo module (ADR-126) serves Argentine freelancers specifically, providing a unique entry point.

## Alternatives Considered

- **Plaid-style bank sync**: Rejected — significant infrastructure, privacy, and regulatory surface; out of scope for the current team size and hosting model.

## Consequences

- Entry remains manual or import-based; no credential/token vault for bank APIs.
- AR-currency handling (ADR-044, ADR-056, ADR-123) is the primary technical differentiator and must remain first-class.
- Monotributo is the niche hook per ADR-126.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
