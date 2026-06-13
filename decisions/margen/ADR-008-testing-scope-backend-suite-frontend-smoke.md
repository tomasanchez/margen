---
project: margen
adr: 008
title: Testing scope: generated backend suite + one frontend smoke test
category: testing
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-008: Testing scope: generated backend suite + one frontend smoke test

## Context

The scaffold ships a pytest suite including monitor/health tests. The foundation should prove both sides connect without heavy e2e infra.

## Decision

Keep the generated backend pytest suite. Add one frontend smoke test for the Margen shell + connection indicator using a mocked readiness fetch.

## Alternatives Considered

- **Backend tests only**: Leaves the shell and connection logic untested — not chosen.
- **Full boot-both-apps e2e test**: Too much infrastructure for a foundation ticket — not chosen.

## Consequences

Light, fast test coverage on both sides. A real e2e connectivity test can be added in a later issue. The frontend smoke test mocks the readiness fetch, so it does not require a running backend. See ADR-006 for what the connection indicator reflects.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
