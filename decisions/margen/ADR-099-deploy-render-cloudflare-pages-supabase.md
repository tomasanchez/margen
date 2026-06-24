---
project: margen
adr: 099
title: Deploy target: Render (API, Docker) + Cloudflare Pages (web) + Supabase
category: architecture
date: 2026-06-23
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-099: Deploy target: Render (API, Docker) + Cloudflare Pages (web) + Supabase

## Context

margen needs a free, no-credit-card hosting setup for the API, frontend, and
database/auth. The backend is a persistent FastAPI server with a native system
dependency (pyzbar → libzbar0, ADR-069) that rules out pip/buildpack-only platforms:
FastAPI Cloud (pip/uv-only managed build, no apt/Dockerfile support) cannot install
libzbar0. The frontend is a static Vite/React build. DB and Auth are already on
Supabase Cloud free tier (ADR-091). Former free go-tos Fly.io and Railway are no
longer usable without a credit card (trial/expiring credits as of mid-2026).

## Decision

Deploy using three free-tier services:

- **API**: Docker service on **Render** (free plan). The existing `apps/api/Dockerfile`
  runtime stage installs `libzbar0` via apt, satisfying ADR-069. The app honors the
  unprefixed `PORT` env var (`UVICORN_PORT` takes precedence, default 8000) so it binds
  Render's injected `$PORT` with no per-host code change.
- **Frontend**: Static site on **Cloudflare Pages**. Builds `apps/web` with pnpm,
  output `dist`. A `public/_redirects` SPA fallback handles TanStack Router client-side
  navigation. `VITE_*` env vars are set in the Pages dashboard.
- **DB + Auth**: Supabase Cloud free tier (already decided, ADR-091). No change.

Infrastructure-as-code: a `render.yaml` Blueprint declares the API service with secrets
as `sync: false` (set in the Render dashboard, never committed to the repo).

**Cross-wiring sequence** (documented in `DEPLOY.md`):
1. Deploy API → obtain Render service URL.
2. Set `VITE_API_BASE_URL` (without `/api/v1`) in the Cloudflare Pages dashboard.
3. Deploy Pages → obtain Pages domain.
4. Set `FASTAPI_BACKEND_CORS_ORIGINS` on Render to the Pages origin.
5. Add the Pages origin to Supabase Auth URL Configuration.

**Keep-alive**: a weekly GitHub Actions cron job curls `/readiness` (runs `SELECT 1`)
to defeat Render's 15-minute inactivity sleep AND Supabase's 7-day inactivity pause.

## Alternatives Considered

- **FastAPI Cloud**: pip/uv-only managed build with no apt/system-package or Dockerfile
  support; cannot install `libzbar0`, so the pyzbar QR-decode path (ADR-069) fails at
  runtime — not chosen.
- **Hugging Face Spaces (Docker) for the API**: more RAM and a gentler 48-hour sleep,
  but Spaces are repo-linked and oriented to public demos; Render is the more
  conventional private API host — kept as a fallback if RAM or cold-start become
  limiting factors.
- **Fly.io / Railway**: no longer offer a usable no-credit-card free tier (trial or
  expiring credits only) as of mid-2026 — not chosen.

## Consequences

Free, no-credit-card hosting that satisfies the `libzbar0` native dependency via Docker.
Accepted trade-offs:

- Render free plan sleeps after 15 minutes of inactivity (30–60 s cold start on first
  request); mitigated by the weekly keep-alive cron.
- Supabase free tier pauses the database after 7 days of inactivity; mitigated by the
  same keep-alive cron (the `/readiness` `SELECT 1` counts as activity).
- `render.yaml` does **not** auto-run Alembic migrations; migrations are applied
  manually (`make migrate` against the Supabase URL) per `DEPLOY.md`.
- `UvicornSettings` now honors the unprefixed `PORT` env var — a project-wide settings
  default change covered by new unit tests; coverage stays at 100 %.
- If RAM consumption (PyMuPDF rendering) or cold-start UX become problems, revisit
  Hugging Face Spaces or a paid Render tier.

Relates to: ADR-069 (pyzbar/libzbar0 native dep, driving Docker requirement),
ADR-091 (Supabase Cloud DB + Auth already in place), ADR-097 (Supabase free-tier
inactivity risk, now mitigated by keep-alive cron).

## Status History

- 2026-06-23: accepted
