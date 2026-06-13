---
project: margen
adr: 014
title: Client-side navigation via TanStack Router
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-014: Client-side navigation via TanStack Router

## Context

Issue #12 introduces navigation between Home and Transactions. ADR-005 explicitly deferred routing ("Router deferred") because navigation was out of scope for the foundation ticket. The foundation now has no router. The user's standard stack uses TanStack Router.

## Decision

Add TanStack Router with code-based routes (e.g. `/` Home, `/transactions`), driving both the desktop sidebar and mobile bottom-nav active states. Keep it minimal (no file-based routing ceremony) for these few screens.

## Alternatives Considered

- **Lightweight state view-switch**: Would be replaced by real routing later; misses type-safe routes and URL state — not chosen.
- **React Router**: Not the standard stack; would diverge from TanStack elsewhere — not chosen.

## Consequences

Reverses the "Router deferred" stance in ADR-005 — that deferral was appropriate for the foundation scope; this ADR activates routing now that navigation is in scope. Establishes routing for future product screens. Adds `@tanstack/react-router`.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
