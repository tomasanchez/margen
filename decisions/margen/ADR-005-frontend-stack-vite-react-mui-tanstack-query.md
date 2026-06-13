---
project: margen
adr: 005
title: Frontend stack: Vite + React 19 + TS + MUI + TanStack Query (Router deferred)
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-005: Frontend stack: Vite + React 19 + TS + MUI + TanStack Query (Router deferred)

## Context

apps/web must be a TS Vite React app rendering a calm, finance-oriented Margen shell (not the default Vite screen) with a backend connection-status indicator. The user's standard frontend stack includes TanStack Router/Query and Material UI.

## Decision

Build apps/web with Vite + React 19 + TypeScript, Material UI (calm finance theme) for the shell, and TanStack Query for the health fetch. Defer TanStack Router — no navigation is in scope for this foundation ticket.

## Alternatives Considered

- **Bare Vite + React + TS + plain fetch**: Shell and data layer would be rebuilt once product work starts — not chosen.
- **Add TanStack Router now**: Final navigation is an explicit non-goal per ADR-001; routing is premature — not chosen.

## Consequences

Establishes the real stack early so product features don't re-scaffold. Adds MUI and TanStack Query dependencies now. No routing layer yet. TanStack Router can be added in a subsequent issue when navigation is scoped. See ADR-006 for how TanStack Query is used to fetch the readiness endpoint. The "Router deferred" stance was reversed by ADR-014 when issue #12 brought navigation into scope. The placeholder slate-blue theme is evolved (not contradicted) by ADR-013.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
