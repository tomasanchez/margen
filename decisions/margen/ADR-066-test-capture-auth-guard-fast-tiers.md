---
project: margen
adr: 66
title: Test the capture auth guard across the fast tiers
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-066: Test the capture auth guard across the fast tiers

## Context

ADR-032 mandates fully-mocked fast tiers for the 100% `make cover` gate. ADR-038 further constrains test structure. The new bearer-token auth dependency on `POST /api/v1/monotributo/capture` (ADR-064) introduces security-critical logic — an incorrect guard (wrong status code, timing vulnerability, fail-open on unconfigured secret) would not be caught without explicit coverage.

The GitHub Actions workflow added in ADR-065 is declarative and is not a candidate for unit testing.

## Decision

Add the following tests, keeping `make cover = 100%` and `make lint` green:

**E2E route tests** (ASGI `TestClient`, mocked bus/UoW — no SQL, consistent with ADR-032/038):

- `test_capture_returns_503_when_token_not_configured` — override the settings so `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN` is `None`; assert `POST /api/v1/monotributo/capture` returns `503`.
- `test_capture_returns_401_on_missing_authorization_header` — configure a token; omit the `Authorization` header; assert `401`.
- `test_capture_returns_401_on_mismatched_bearer_token` — configure a token; send a wrong token; assert `401`.
- `test_capture_dispatches_with_correct_token` — configure a token; send the correct `Authorization: Bearer <token>` header; assert `202` (capture dispatched).

Settings are overridden via the app/container dependency-override mechanism, not via real environment mutation, so tests are isolated and parallelism-safe.

**Unit test** (if the dependency carries non-trivial logic beyond a single `hmac.compare_digest` call):

- Test header parsing (e.g., `Bearer ` prefix extraction, case handling) and the constant-time comparison branch in isolation.

**What is NOT tested here:**

- The GitHub Actions workflow (ADR-065) — validated by YAML inspection and a manual `workflow_dispatch` dry run once secrets exist.
- The capture business logic itself — covered by existing tests from ADR-052.

## Alternatives Considered

- **Skip auth tests**: the guard is security-critical and straightforward to get wrong (fail-open, wrong status code, string comparison timing leak); it must be covered and the 100% gate must hold.

## Consequences

- All three auth states (disabled/unauthorized/authorized) are pinned by fast tests; regressions surface immediately in CI.
- The 100% `make cover` gate continues to hold — no carve-outs needed.
- The test approach (settings override, mocked bus/UoW) is consistent with ADR-032/038; no new test infrastructure is introduced.
- See ADR-064 for the auth dependency under test, ADR-065 for the workflow that calls the guarded endpoint.

## Status History

- 2026-06-14: accepted
