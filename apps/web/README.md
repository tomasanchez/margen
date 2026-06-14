# Margen — web

The Margen frontend: React 19 + Vite + TypeScript, Material UI + Tailwind CSS v4 (shared design
tokens), TanStack Query (server state) and TanStack Router (type-safe routing). It talks to the
FastAPI backend in [`../api`](../api); the API base URL comes only from `VITE_API_BASE_URL`.

See the [repo README](../../README.md) for the full stack and the quick start. From the repo
root, `make web` runs the dev server and `make install` installs deps.

## Package manager

This app uses **pnpm** (pinned via Corepack — `pnpm@10.12.4`, see `packageManager` in
`package.json`). Enable it once with `corepack enable`, then use `pnpm`, not `npm`.

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm install` | Install dependencies (strict, content-addressed) |
| `pnpm dev` | Start the Vite dev server (http://localhost:5173) |
| `pnpm build` | Type-check (`tsc -b`) and build for production |
| `pnpm preview` | Preview the production build locally |
| `pnpm test` | Run the Vitest suite (Testing Library) |
| `pnpm run lint` | Lint with ESLint |

## Environment

Copy `.env.example` to `.env` (git-ignored). The only variable is `VITE_API_BASE_URL`
(defaults to the local backend, `http://localhost:8000`) — the single source of the API URL,
never hardcoded.

## Structure

```text
src/
  api/         # typed HTTP clients (unwrap {data}, parse Decimal strings) + TanStack Query hooks
  components/  # shared UI (app shell, account menu, status pill, error/empty states)
  features/    # home, transactions, monotributo, settings
  lib/         # formatting helpers (es-AR money, dates)
  theme/       # MUI theme + color mode (shares tokens with Tailwind)
  router.tsx   # TanStack Router route tree
```
