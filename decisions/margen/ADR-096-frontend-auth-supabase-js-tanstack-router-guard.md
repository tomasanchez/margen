---
project: margen
adr: 096
title: Frontend auth: supabase-js session + TanStack Router beforeLoad guard
category: ux
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-096: Frontend auth: supabase-js session + TanStack Router beforeLoad guard

## Context

The React app (Vite, MUI, TanStack Router/Query) has no login UI or session management.
We need session handling, protected routes, and sign-in method(s) that fit the existing
stack and design conventions (ADR-013/019).

## Decision

Use **`@supabase/supabase-js`** on the frontend to manage the session (persisted in
`localStorage`, auto-refresh, and OAuth redirect handling). Enforce auth via **TanStack
Router `beforeLoad` guards** that redirect unauthenticated users to a new `/login`
route, with session state available in router context and synced to TanStack Query.

Enable **Email + password AND OAuth sign-in** at launch. Build a `/login` UI consistent
with the existing MUI theme and accessibility conventions (ADR-013/019).

## Alternatives Considered

- **In-memory token + httpOnly refresh cookie**: much more plumbing (custom backend
  cookie/refresh route, CORS cookie handling); `@supabase/supabase-js` is the standard
  path for this scope — not chosen.
- **Layout-level gate component**: coarser and less idiomatic than route-level
  `beforeLoad` guards in a TanStack Router project — not chosen.

## Consequences

Adds `@supabase/supabase-js` as a frontend dependency. Introduces a Supabase client
singleton, a `/login` route + UI, an auth context/provider feeding the router, and an
`Authorization: Bearer` header on FastAPI calls. Token is stored in JS-accessible
storage — the XSS trade-off is accepted for this scope and is tracked in ADR-097.

Relates to: ADR-013/019 (MUI theme and accessibility), ADR-090 (auth business
decision), ADR-091 (Supabase hybrid; frontend only talks to Supabase for auth
handshake), ADR-092 (FastAPI validates the token the frontend forwards), ADR-097
(risks including localStorage XSS trade-off).

## Status History

- 2026-06-23: accepted
