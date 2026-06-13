---
project: margen
adr: 006
title: Connectivity via /monitor/readiness with env-driven CORS allowlist
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-006: Connectivity via /monitor/readiness with env-driven CORS allowlist

## Context

The frontend must show a truthful backend connection state, and the browser needs CORS permission to call the API in local dev.

## Decision

Frontend calls GET /readiness (confirms API + DB via SELECT 1). Backend CORS allowed origins come from an env var (`FASTAPI_BACKEND_CORS_ORIGINS`, JSON array) defaulting to the Vite dev origin http://localhost:5173 — no wildcard. Default ports: API 8000, web 5173.

> **Implementation note (2026-06-13):** The cosmic-fastapi template version generated for Margen mounts the monitor router at the root, so the live paths are `/readiness` and `/liveness` (NOT `/monitor/readiness`). The CORS setting is exposed as `FASTAPI_BACKEND_CORS_ORIGINS` (Pydantic field `BACKEND_CORS_ORIGINS` with `env_prefix="FASTAPI_"`). Use these exact paths/vars.

## Alternatives Considered

- **Call /monitor/liveness**: Only confirms the process is up, not the DB; less truthful as a 'connected' signal — not chosen.
- **Wildcard CORS (*)**: Sloppy and does not carry cleanly to production — not chosen.

## Consequences

The connection indicator reflects full-stack health (API process + database reachable). CORS origins are configurable per environment with no hardcoded production URLs. Depends on ADR-003 (readiness endpoint from scaffold), ADR-004 (Postgres backing the SELECT 1), ADR-005 (TanStack Query drives the fetch), and ADR-007 (BACKEND_CORS_ORIGINS in env).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
