---
project: margen
adr: 64
title: Protect POST /api/v1/monotributo/capture with a shared-secret bearer token
category: security
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-064: Protect POST /api/v1/monotributo/capture with a shared-secret bearer token

## Context

ADR-052 shipped a thin `POST /api/v1/monotributo/capture` endpoint intended as the target for an external scheduler (in-process schedulers were rejected in that same ADR). The endpoint was left unauthenticated with a TODO, noted explicitly at the time. GitHub issue #20 requires the endpoint to be locked down before it is wired to a scheduled trigger.

There is no user-auth or identity system in the MVP. The caller is a machine (a cron job), not a human. A proportionate machine-to-machine control is needed — not a full OAuth/OIDC stack.

ADR-046 and ADR-048 establish the Monotributo domain; ADR-030 governs `ResponseModel` conventions on the routes that would return error responses.

## Decision

Add a configurable shared-secret token setting via the existing pydantic-settings convention (`FASTAPI_` env prefix):

- Setting name: `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN`, typed `Optional[str]`, default `None`.
- Implement a FastAPI dependency that guards `POST /capture` only:
  - When the setting is `None` (not configured): return `503 Service Unavailable` — the endpoint is treated as **disabled**. This is a fail-closed posture; you cannot authenticate against an unset secret.
  - When the setting is configured: require an `Authorization: Bearer <token>` header. A missing, malformed, or mismatched header returns `401 Unauthorized`. Comparison uses `hmac.compare_digest` (constant-time) to prevent timing-oracle attacks.
- All `GET /monotributo` read-record routes and every other read endpoint stay open as before — only the capture write path is guarded.
- The secret is provided via environment variables or repository secrets; it is never committed. `.env.example` documents `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN=` with an empty value.

## Alternatives Considered

- **Leave it unauthenticated**: anyone could trigger snapshot writes once the API is public — unacceptable for an endpoint exposed to a scheduled trigger.
- **Full user-auth / OAuth**: no identity system exists in the MVP and the caller is a machine; a shared secret is the proportionate machine-to-machine control.
- **Custom `X-Capture-Token` header**: functionally equivalent but less standard than `Authorization: Bearer`; the standard header is preferred.
- **Allow when token unset (dev convenience)**: fail-open is unsafe; `503`-when-unconfigured is the safe default and the cron only runs once secrets are configured.

## Consequences

- The capture write path is protected by a static bearer token; the secret must be configured (env/repo secret) wherever capture is invoked, and rotated via that env var.
- Idempotency keyed by `period_end` (ADR-052) means repeated authorized calls are safe.
- A heavier auth scheme (e.g., service tokens, mTLS) can replace this dependency when a real identity system lands — the guard is a single FastAPI dependency.
- See ADR-065 for the GitHub Actions workflow that supplies the token, and ADR-066 for the test coverage of the auth states.

## Status History

- 2026-06-14: accepted
