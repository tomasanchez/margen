# Margen

Personal finance app — fast transaction entry, monthly summaries, Monotributo tracking, and
FX-aware income/expense flows.

This repository is a monorepo containing two apps:

```text
margen/
  apps/
    api/   # FastAPI backend (scaffolded from cosmic-fastapi)
    web/   # TypeScript + Vite + React frontend
  decisions/  # Architecture Decision Records (ADRs)
  README.md
  .gitignore
```

> Status: **foundation only.** This is the project scaffold — no product features yet
> (no expense entry, Monotributo logic, auth, or dashboards). See `decisions/margen/` for
> the decisions behind this setup.

## Prerequisites

Local dev is supported on **Windows 11 / PowerShell** (and macOS/Linux).

| Tool | Version used | Purpose |
|------|--------------|---------|
| [uv](https://docs.astral.sh/uv/) | 0.7.x | Python deps & backend tasks |
| [Node.js](https://nodejs.org/) | 22.x (npm 10.x) | Frontend |
| [Docker](https://www.docker.com/) | any recent | Local PostgreSQL |
| `make` | optional | Backend convenience targets (an `alembic` fallback is shown) |

## Quick start

Open **two terminals** — one for the backend, one for the frontend.

### 1. Backend — `apps/api`

```powershell
cd apps/api

# Copy the env example and adjust if needed (never commit the real .env)
copy .env.example .env

# Start PostgreSQL (service name: db)
docker compose up -d db

# Install dependencies
uv sync

# Apply migrations
make migrate          # equivalent to: uv run alembic upgrade head

# Run the API (http://localhost:8000)
uv run python -m margen_api.main
```

Verify it's healthy:

```powershell
# Liveness (process up):  http://localhost:8000/liveness
# Readiness (API + DB):   http://localhost:8000/readiness  -> {"data":{"status":"Ready"}}
```

Run the backend test suite:

```powershell
uv run pytest
```

### 2. Frontend — `apps/web`

```powershell
cd apps/web

# Copy the env example (defaults to the local backend)
copy .env.example .env

# Install dependencies
npm install

# Run the dev server (http://localhost:5173)
npm run dev
```

Open http://localhost:5173 — the Margen shell shows a **backend connection status**
indicator that calls `GET {VITE_API_BASE_URL}/readiness`. With both apps running it should
read **connected**.

## Environment variables

Example files (`.env.example`) are committed; real `.env` files are git-ignored — **never
commit secrets**.

### Backend (`apps/api/.env`)

| Variable | Example | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql+asyncpg://margen-api:margen-api@localhost:5432/margen-api` | Async SQLAlchemy URL |
| `FASTAPI_BACKEND_CORS_ORIGINS` | `["http://localhost:5173"]` | JSON array of allowed origins (no wildcard) |
| `FASTAPI_DEBUG` | `true` | Dev only |

### Frontend (`apps/web/.env`)

| Variable | Example | Notes |
|----------|---------|-------|
| `VITE_API_BASE_URL` | `http://localhost:8000` | Backend base URL — the only place the API URL is sourced; never hardcoded |

## Ports

| App | Default port | Override |
|-----|--------------|----------|
| Backend (FastAPI) | `8000` | change the run command's host/port |
| Frontend (Vite) | `5173` | Vite auto-falls back to the next free port if 5173 is taken — if it lands on a different port, add that origin to `FASTAPI_BACKEND_CORS_ORIGINS` or free port 5173 |
| PostgreSQL | `5432` | edit `apps/api/docker-compose.yaml` and `DATABASE_URL` |

## Backend scaffold reproducibility

`apps/api` was generated from the [`cosmic-fastapi`](https://github.com/tomasanchez/cosmic-fastapi)
Copier template. To regenerate from scratch, run from the repo root with these answers
(the Copier template lives on the `main` ref):

```text
uvx copier copy --trust --vcs-ref main --defaults gh:tomasanchez/cosmic-fastapi apps/api
```

Answers used:

| Question | Value |
|----------|-------|
| project_name | `Margen API` |
| project_slug | `margen-api` |
| package_name | `margen_api` |
| project_description | `Margen backend API` |
| author_name | `Tomas Sanchez` |
| author_email | `tomas.sanchez@wheels.com` |
| github_owner | `tomasanchez` |
| license | `MIT` |
| python_version | `3.13` |
| database | `postgres` (asyncpg) |
| include_user_example | `false` |

## Decisions

Architecture, data, security, and testing decisions for this foundation are recorded as ADRs
under [`decisions/margen/`](decisions/margen/).
