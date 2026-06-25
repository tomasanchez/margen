---
project: margen
adr: 114
title: Per-user ownership scope boundaries and accepted risks
category: risks
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-114: Per-user ownership scope boundaries and accepted risks

## Context

Recording the explicit boundaries and accepted risks of the single-owner-oriented
per-user data lock-down (ADR-107) for future reference.

## Decision

Accept and track the following scope boundaries and risks:

1. **No multi-owner / sharing**: strictly one owner per row; no team or household
   sharing — revisit only if a multi-user feature is introduced.
2. **Capture is single-owner**: the M2M `POST /monotributo/capture` writes to a
   configured-env owner `user_id` (ADR-112); revisit if monotributo must serve
   multiple users simultaneously.
3. **Static-token capture credential is out of scope**: ADR-064's bearer token is
   trusted and managed separately; this change does not alter it.
4. **Read models carry no ownership column**: summaries, insights, and monotributo
   standing are scoped by filtering their transaction source by `user_id` — no
   separate ownership column is added to the read model tables themselves.
5. **App-layer enforcement only, no RLS backstop**: a missed `user_id` predicate in a
   reader would leak rows; mitigated by `NOT NULL` on `user_id` (ADR-109), explicit
   parameter threading (ADR-108), and the two-stub-user isolation tests (ADR-113).
6. **Frontend is expected to need no changes**: the same API endpoints and JWT-bearing
   requests are used — to be verified during implementation.

## Alternatives Considered

— (risk log; no alternatives apply)

## Consequences

These are logged as risks and open items; none block the lock-down. Items 1 and 2 are
the most likely to require follow-up ADRs if margen adds more users.

Relates to: ADR-064 (static-token capture, unchanged), ADR-095 (no-RLS decision
whose enforcement gap is risk 5 here), ADR-107 (ownership business decision),
ADR-108 (explicit threading mitigating risk 5), ADR-109 (NOT NULL tightening
mitigating risk 5), ADR-112 (configured-owner capture — risk 2), ADR-113 (isolation
tests — mitigation for risk 5).

## Status History

- 2026-06-25: accepted
