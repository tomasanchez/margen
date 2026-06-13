---
project: margen
adr: 020
title: Prototype assumptions, open items, and edge cases
category: risks
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-020: Prototype assumptions, open items, and edge cases

## Context

A mock-data prototype hardcodes values and defers logic that the real product will compute; these should be tracked and must inform backend contracts (issue #3).

## Decision

Track and handle the following assumptions and edge cases:

1. FX rate hardcoded (MEP ~1.245) — no live fetch (explicit non-goal of ADR-012).
2. Monotributo limits/category thresholds hardcoded from the AFIP scale; no real calculation engine.
3. Month switcher operates over the months present in mock data (June current, May/April historical); document its prototype semantics.
4. Edge cases from the issue must render gracefully: empty transactions, no Monotributo category configured, USD transaction without a rate, very large ARS amounts, long names (truncate/ellipsis), filters with no results, mobile long labels/amounts.
5. Data resets on reload (in-memory, per ADR-015).

These assumptions are explicit inputs to the backend contract design in issue #3.

## Alternatives Considered

None — these are known constraints of the prototype scope, not competing approaches.

## Consequences

Clear boundaries of what is real vs faked; a checklist of edge cases for implementation and review; explicit handoff of assumptions to backend planning. Relates to ADR-012 (scope non-goals) and ADR-015 (in-memory data reset).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
