---
project: margen
adr: 037
title: Calm error / unavailable / loading experience
category: ux
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-037: Calm error / unavailable / loading experience

## Context

An explicit acceptance criterion for #14: when the backend is unavailable the UI must show a calm state and never crash; slow network must show loading indicators; save/delete failures must not lose the UI. The app already has skeleton loading patterns from the prototype.

## Decision

Use TanStack Query `isError` / `isPending` states throughout:

- When the transactions query errors (e.g. backend down), Transactions and Home render a calm, reusable "Can't reach the server" panel with a Retry button that calls `refetch()` — never an unhandled crash.
- Loading reuses the existing skeleton components from the prototype.
- Mutation failures (save/delete) show a brief inline or snackbar message and keep the form open so the user does not lose their input.

One small shared error/unavailable component is introduced so later real-data features (#6/#7/#8) can reuse it.

## Alternatives Considered

- **Minimal silent fallback to empty list + console error**: Fails the calm/trustworthy UX intent (ADR-013), offers no recovery path, and provides no signal to the user — not chosen.

## Consequences

Trustworthy, recoverable behavior under degraded network or backend outage. One reusable error/unavailable component the subsequent real-data issues can adopt. Complements ADR-036 (mutation error surfacing). Loading skeletons are reused rather than redesigned, keeping visual consistency.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
