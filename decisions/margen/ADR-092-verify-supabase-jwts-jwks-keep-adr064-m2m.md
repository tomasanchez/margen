---
project: margen
adr: 092
title: Verify Supabase JWTs in FastAPI via JWKS; keep ADR-064 static token for M2M
category: security
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-092: Verify Supabase JWTs in FastAPI via JWKS; keep ADR-064 static token for M2M

## Context

FastAPI must authenticate user requests bearing Supabase-issued JWTs. Supabase Cloud
supports asymmetric signing keys exposed via a JWKS endpoint (RS256/ES256). The
existing scheduled capture endpoint uses a separate static bearer token (ADR-064);
we must decide whether that scheme is touched.

## Decision

FastAPI validates Supabase-issued JWTs using **asymmetric verification** against
Supabase's JWKS endpoint, with the JWKS response cached locally. A reusable FastAPI
auth dependency (`Authorization: Bearer`) resolves the current user from verified
claims and protects all user-facing routes.

The existing static-token guard on the M2M capture endpoint (ADR-064) is **kept
as-is**. The two schemes coexist: user routes use Supabase JWT verification; the
capture endpoint uses the static token.

## Alternatives Considered

- **Shared HS256 secret**: symmetric secret must be distributed and rotated manually;
  JWKS avoids a shared secret entirely — not chosen.
- **Call Supabase `/auth/v1/user` per request**: per-request latency plus a hard
  runtime dependency on Supabase for every API call — not chosen.
- **Migrate capture endpoint to Supabase service identity**: unneeded churn; the cron +
  ADR-064 work today and are out of scope for this feature — not chosen.

## Consequences

FastAPI gains a JWKS fetch/cache module and a reusable `current_user` auth dependency.
ADR-064 remains fully valid for M2M capture. Token-verify logic is unit-testable with
a locally-minted key pair (see ADR-098 for test strategy).

Relates to: ADR-064 (M2M static token, retained), ADR-091 (Supabase hybrid
architecture), ADR-093 (secret management for JWKS config), ADR-098 (test strategy
for auth).

## Status History

- 2026-06-23: accepted
