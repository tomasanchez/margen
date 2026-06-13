---
project: margen
adr: 015
title: Mock data via TanStack Query over an in-memory mock-async API
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-015: Mock data via TanStack Query over an in-memory mock-async API

## Context

The prototype needs realistic data and add/edit/delete behavior without a backend. TanStack Query is already installed (ADR-005). The concept scripts provide realistic seed data.

## Decision

Implement a mock async API module (in-memory array seeded from the concept data, with simulated latency) exposed through TanStack Query queries and mutations; mutations update the in-memory store and invalidate queries. Home and Transactions read from the SAME shared source. State is IN-MEMORY ONLY — reset on reload (no localStorage). Filter/search state is local to the Transactions screen.

## Alternatives Considered

- **React Context + useReducer**: Simpler, but the user chose a mock-async layer that mirrors the eventual backend so the real API swap is trivial — not chosen.
- **localStorage-backed persistence**: Adds serialization/migration concerns not needed for a prototype; in-memory keeps it clearly a prototype — not chosen.

## Consequences

The query/mutation shape previews the real API contract (feeds issue #3). Reloading resets data — this is intentional and clearly signals prototype boundaries. Swapping the mock module for a real client later is localized to the mock layer.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
