---
project: margen
adr: 012
title: UI-first mock prototype scope for the MVP
category: business
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-012: UI-first mock prototype scope for the MVP

## Context

Issue #12 (parent epic #2) calls for validating the MVP experience through implementation before locking backend contracts. The Home and Transactions UX concepts already define product behavior. The goal is product discovery — learn what data the UI actually needs.

## Decision

Build a FRONTEND-ONLY prototype of Home + Transactions + quick Add/Edit using mock, in-memory data. No backend persistence. Statement IMPORT (shown in the Transactions concept) is explicitly EXCLUDED from MVP per the issue's Product Decision and becomes a later issue.

## Alternatives Considered

- **Define backend contracts first, then build UI**: Risks a backend-driven form generator; the issue wants product flows to inform the contracts — not chosen.
- **Include statement import now**: Import adds parsing, review, duplicate detection, and trust problems too large for the first usable MVP — deferred.

## Consequences

Learnings feed backend contract issue #3. Non-goals: persistence, auth, import, automatic FX fetching, final Monotributo engine, complex charting, production data model. The prototype is intentionally throwaway-friendly on the data layer but real on UX.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
