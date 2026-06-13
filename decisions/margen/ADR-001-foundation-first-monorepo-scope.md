---
project: margen
adr: 001
title: Foundation-first monorepo scope
category: business
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-001: Foundation-first monorepo scope

## Context

Margen (a personal finance app: fast transaction entry, monthly summaries, Monotributo tracking, FX-aware flows) needs a stable home before product features are built. Issue #1 is a Must-have MVP foundation ticket and must stay intentionally boring and infrastructure-focused to avoid scope creep.

## Decision

Deliver ONLY the monorepo scaffold: apps/api (FastAPI) + apps/web (React), Windows-friendly documented local dev, env examples without secrets, and a minimal end-to-end frontend->backend health-check path. No product domain.

## Alternatives Considered

- **Build foundation + first domain feature together**: Mixes infra with domain modeling, invites scope creep, and risks an unstable base — not chosen.

## Consequences

Explicit non-goals: no expense entry, no Monotributo calculations, no auth, no analytics dashboards, no final navigation design, no DB schema beyond scaffold defaults. Product work is unblocked by a clean base.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
