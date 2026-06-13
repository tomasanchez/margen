---
project: margen
adr: 007
title: Environment variable and secret management
category: security
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-007: Environment variable and secret management

## Context

Acceptance criteria require example env files or documented env var names without committing secrets, and the frontend must not hardcode production API URLs.

## Decision

Commit .env.example for both apps (backend env includes database_url and BACKEND_CORS_ORIGINS; frontend includes VITE_API_BASE_URL). Real .env files are gitignored. The frontend reads the API base URL exclusively from VITE_API_BASE_URL.

## Alternatives Considered

- **Commit a working .env**: Risks leaking secrets and pins environment-specific values into version control — not chosen.

## Consequences

Contributors copy .env.example to .env and fill in real values. No secrets in git. API base URL is environment-driven on the frontend. Aligns with the CORS env var established in ADR-006.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
