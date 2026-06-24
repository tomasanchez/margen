---
project: margen
adr: 098
title: Auth test strategy: dependency-override stub plus focused JWKS-verify unit tests
category: testing
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-098: Auth test strategy: dependency-override stub plus focused JWKS-verify unit tests

## Context

The 100% coverage gate runs hermetically on in-memory SQLite (ADR-032 / scaffold
ADR-0019) with no external infra. Auth must not break that gate. We need to decide how
to cover auth logic without requiring a live Supabase instance or a Dockerized GoTrue
in CI.

## Decision

**Backend**: use FastAPI `dependency_overrides` to swap the auth dependency for a stub
user in unit/e2e tests, keeping those tests hermetic and fast. Additionally, add
**focused unit tests for the real JWKS-verify logic** using a locally-minted key pair,
covering: valid token, expired token, wrong issuer, and bad-signature cases.

**Frontend**: test route-guard redirect and login flow with a mocked `@supabase/supabase-js`
client.

No live Supabase instance or Dockerized GoTrue in the coverage gate.

## Alternatives Considered

- **Always pass real minted JWTs through the verify path in every test**: more setup
  overhead in every test; the override-stub keeps the bulk of tests simple while a
  focused suite still covers the real verify path — not chosen as the default.
- **Dockerized Supabase in CI**: slow, heavy, and conflicts with the in-memory-SQLite
  hermetic gate philosophy (ADR-032) — not chosen.

## Consequences

The coverage gate stays hermetic and fast. The real token-verify logic still has direct
test coverage via the locally-minted key pair suite. A shared test auth-override helper
is added to the backend test suite for easy reuse across test modules.

Relates to: ADR-032 (hermetic in-memory coverage gate), ADR-092 (JWKS-verify logic
under test), ADR-064 (M2M static-token path also needs a stub/override).

## Status History

- 2026-06-23: accepted
