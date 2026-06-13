---
project: margen
adr: 009
title: Foundation risks and open items
category: risks
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-009: Foundation risks and open items

## Context

Local dev on Windows has known friction points for this scaffold.

## Decision

Track and mitigate the following risks:

1. **Port conflicts** — document default ports (API 8000, web 5173) and how to override them.
2. **Postgres dependency** — document that Docker Postgres must be running before `make migrate` and before the readiness probe passes.
3. **Copier inputs** — standardize and document the exact answers used so the scaffold is reproducible by any contributor.

## Alternatives Considered

—

## Consequences

These risks are documented in the root README and revisited if they cause friction during onboarding or CI. Relates to ADR-004 (Postgres dependency), ADR-006 (readiness probe and default ports), and ADR-003 (Copier inputs).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
