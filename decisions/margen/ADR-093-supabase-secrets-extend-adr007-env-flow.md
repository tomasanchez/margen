---
project: margen
adr: 093
title: Supabase secrets extend the existing env/secret flow; service-role key server-side only
category: security
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-093: Supabase secrets extend the existing env/secret flow; service-role key server-side only

## Context

Supabase introduces several new secrets: project URL, anon (publishable) key,
service-role key, JWKS/JWT config, and the Postgres connection URL. ADR-007 already
defines the env/.env secret management convention for margen. We must decide how these
new secrets are handled and which may reach the client.

## Decision

Manage all Supabase secrets through the **existing ADR-007 env/.env mechanism**. No
new secret-store tooling is introduced. Boundary:

- **Frontend may receive**: Supabase project URL + anon/publishable key (safe by
  design — Supabase's RLS gates direct DB access; FastAPI is the domain gateway here).
- **Server-side only**: service-role key and Postgres connection URL — never shipped
  to the client.

## Alternatives Considered

- **Dedicated vault/secret manager**: new tooling and ops overhead for a small app;
  ADR-007 flow is sufficient provided the service-role key stays server-side — not
  chosen.

## Consequences

Frontend build receives only the Supabase URL + anon key. Backend config gains the
DB URL, service-role key, and JWKS/JWT config. Pattern stays consistent with ADR-007.

Relates to: ADR-007 (env/secret management baseline), ADR-091 (Supabase hybrid
architecture), ADR-092 (JWKS config is one of the new secrets).

## Status History

- 2026-06-23: accepted
