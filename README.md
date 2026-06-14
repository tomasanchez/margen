# Margen

Personal finance app — fast transaction entry, monthly summaries, Monotributo tracking, and
FX-aware income/expense flows.

This repository is a plain-folder monorepo containing two apps:

```text
margen/
  apps/
    api/   # FastAPI backend (scaffolded from cosmic-fastapi)
    web/   # React + Vite + TypeScript frontend
  decisions/  # Architecture Decision Records (ADRs)
  Makefile    # root convenience targets (run/install/test both apps)
  README.md
```

> Status: **active MVP build.** Shipped so far: transaction entry + persistence,
> monthly summaries (trend + category breakdown), a real Monotributo calculation with
> snapshot history, trustworthy USD FX (suggested MEP/Official rates, user-confirmed),
> and real settings (display currency, FX default, Monotributo category). See
> `decisions/margen/` for the decisions behind every piece.

## Tech stack

**Backend — `apps/api`** (domain-first "cosmic" architecture)

| Tool | Purpose |
|------|---------|
| [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/) | Async HTTP API |
| [SQLAlchemy 2 (async)](https://www.sqlalchemy.org/) + [asyncpg](https://magicstack.github.io/asyncpg/) | Persistence over PostgreSQL |
| [Alembic](https://alembic.sqlalchemy.org/) | Database migrations |
| [Pydantic 2](https://docs.pydantic.dev/) / pydantic-settings | Schemas, settings, boundary validation |
| [uv](https://docs.astral.sh/uv/) | Python deps & task running |
| [pytest](https://docs.pytest.org/) + coverage, [Ruff](https://docs.astral.sh/ruff/), [pyrefly](https://github.com/facebook/pyrefly) | Tests (100% gate), lint/format, type-check |

**Frontend — `apps/web`**

| Tool | Purpose |
|------|---------|
| [React 19](https://react.dev/) + [Vite](https://vite.dev/) + TypeScript | UI + dev server / build |
| [Material UI](https://mui.com/material-ui/) (+ Emotion) | Component library / theming |
| [Tailwind CSS v4](https://tailwindcss.com/) | Utility styling (shares the MUI design tokens) |
| [TanStack Query](https://tanstack.com/query) + [TanStack Router](https://tanstack.com/router) | Server state + type-safe routing |
| [pnpm](https://pnpm.io/) (via Corepack, pinned `pnpm@10.12.4`) | Package manager |
| [Vitest](https://vitest.dev/) + Testing Library, [ESLint](https://eslint.org/) | Tests, lint |

**Shared**

| Tool | Purpose |
|------|---------|
| [Docker](https://www.docker.com/) | Local PostgreSQL |
| `make` | Root + per-app convenience targets |

## Prerequisites

Local dev is supported on **Windows 11 / PowerShell** (and macOS/Linux). Install
[uv](https://docs.astral.sh/uv/), [Node.js](https://nodejs.org/) 22.x with
[Corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable` — provides the
pinned pnpm), [Docker](https://www.docker.com/), and `make`.

## Quick start

The root `Makefile` wraps both apps. First copy the env examples (real `.env` files are
git-ignored — never commit secrets):

```powershell
copy apps\api\.env.example apps\api\.env
copy apps\web\.env.example apps\web\.env
```

Then, from the repo root, install deps and start PostgreSQL once:

```powershell
make install          # uv sync (api) + pnpm install (web)
make db               # start the local PostgreSQL container
make migrate          # apply backend migrations
```

Now run the two apps in **separate terminals** (`make dev` prints this reminder):

```powershell
make api               # FastAPI backend on http://localhost:8000
make web               # Vite frontend on http://localhost:5173
```

Open http://localhost:5173 — the Margen shell shows a **backend connection status**
indicator that calls `GET {VITE_API_BASE_URL}/readiness`. With both apps running it should
read **connected**.

Root `Makefile` targets: `make help` lists them all (`install`, `db`, `migrate`, `api`,
`web`, `dev`, `test`, `lint`). Each app also keeps its own targets/scripts —
`apps/api` has its `make` (`make cover`, `make integration`, `make lint`, …) and `apps/web`
its pnpm scripts (`pnpm dev/build/test/lint`).

### Verify the backend is healthy

```powershell
# Liveness (process up):  http://localhost:8000/liveness
# Readiness (API + DB):   http://localhost:8000/readiness  -> {"data":{"status":"Ready"}}
```

### Run the tests

```powershell
make test              # backend cover (unit+e2e, 100% gate) + frontend Vitest

# Backend integration tier — runs against a DISPOSABLE test database, never your
# dev `db`. It creates and DROPS the schema per test, so it uses a separate,
# ephemeral Postgres (margen-api-test on port 5433):
cd apps/api
docker compose --profile test up -d db-test   # start the throwaway test DB
make integration                              # defaults to the test DB
```

> ⚠️ The integration tier is **destructive** (it drops all tables). `make integration`
> defaults `TEST_DATABASE_URL` to the disposable `margen-api-test` DB, and the test
> suite **refuses to run** against any database whose name doesn't contain `test` —
> so it can never wipe your dev/real database.

## Environment variables

Example files (`.env.example`) are committed; real `.env` files are git-ignored — **never
commit secrets**.

### Backend (`apps/api/.env`)

| Variable | Example | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql+asyncpg://margen-api:margen-api@localhost:5432/margen-api` | Async SQLAlchemy URL |
| `FASTAPI_BACKEND_CORS_ORIGINS` | `["http://localhost:5173"]` | JSON array of allowed origins (no wildcard) |
| `FASTAPI_DEBUG` | `true` | Dev only |
| `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN` | _(empty)_ | Bearer token for the scheduled `POST /monotributo/capture`; empty = endpoint disabled (503). Set only where the capture cron runs |

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
| author_email | `info@tomsanchez.com` |
| github_owner | `tomasanchez` |
| license | `MIT` |
| python_version | `3.13` |
| database | `postgres` (asyncpg) |
| include_user_example | `false` |

## Decisions

Architecture, data, security, and testing decisions for this foundation are recorded as ADRs
under [`decisions/margen/`](decisions/margen/).
