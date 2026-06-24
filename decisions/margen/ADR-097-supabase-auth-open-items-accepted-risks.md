---
project: margen
adr: 097
title: Supabase + Auth open items and accepted risks
category: risks
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-097: Supabase + Auth open items and accepted risks

## Context

Several details were intentionally not finalized during discovery to stay within scope.
These are recorded here so they are tracked and do not fall through the cracks during
implementation.

## Decision

Record the following as open items to resolve during implementation or a follow-up
chunk:

1. **OAuth provider(s)**: Google assumed as the first; requires app registration and
   redirect URI configuration in both the OAuth provider console and Supabase.
2. **Supabase env topology**: assume a single Cloud project to start; separate dev/prod
   projects are deferred.
3. **Transactional email**: Supabase's built-in email has low rate limits and is not
   suitable for production volume — a custom SMTP provider must be configured for
   email-verification and password-reset flows before going live.
4. **Deferred data migration**: bulk backfill of existing data under the authenticated
   owner (ADR-090/094) is out of scope for this work item.
5. **Supabase Cloud availability**: login is unavailable if Supabase is unreachable; no
   offline fallback for the login flow.
6. **localStorage XSS trade-off** (ADR-096): `@supabase/supabase-js` stores tokens in
   `localStorage`; acceptable for this scope but should be revisited if the threat model
   changes.
7. **RLS revisit** (ADR-095): Row-Level Security is deferred; revisit if any client
   ever accesses Supabase Postgres directly.

## Alternatives Considered

None — this is a tracking record, not a choice between options.

## Consequences

These items are tracked as risks/open questions and folded into the implementation
plan. None block standing up auth for the initial release.

Relates to: ADR-090 (auth business; deferred migration), ADR-091 (Supabase Cloud
runtime dependency), ADR-094 (data migration deferred), ADR-095 (RLS deferred),
ADR-096 (localStorage trade-off).

## Status History

- 2026-06-23: accepted
