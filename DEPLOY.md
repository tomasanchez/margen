# Deploying Margen (free tier)

Margen runs on three free services:

| Component        | Host                         | Notes                                              |
| ---------------- | ---------------------------- | -------------------------------------------------- |
| API (FastAPI)    | Render (Docker, free plan)   | Sleeps after 15 min idle; cold start ~50s          |
| Web (React/Vite) | Cloudflare Pages (static)    | SPA, deep-link routing via `public/_redirects`     |
| DB + Auth        | Supabase Cloud (free)        | Pauses after 7 days idle (ADR-091)                 |

The API image bundles the native `libzbar0` library for AFIP QR decoding
(ADR-069). The API binds the port Render injects (`$PORT`) with no per-host code
change — `UvicornSettings` reads the unprefixed `PORT`, falling back to 8000.

Secrets are never committed (ADR-007). All `sync: false` env vars in
[`render.yaml`](render.yaml) and all `VITE_*` build vars are entered in the
respective dashboards.

> Follow the steps in order. The cross-wiring (step C) depends on having the
> Render URL before configuring Pages, and the Pages URL before configuring CORS.

---

## Deployment & CI/CD

The API does **not** auto-deploy on a raw git push. Instead, a GitHub Actions
pipeline runs CI (lint, coverage, and the Postgres integration tier), then
applies Alembic migrations to Supabase, then triggers Render's **Deploy Hook** —
all only on a push to `main`. Migrations run **before** the deploy
(schema-before-code) so the new image never starts against an unmigrated
database. Broken code can never deploy because each stage gates the next
([`.github/workflows/api.yml`](.github/workflows/api.yml): `migrate` job
`needs: [build, integration]`, `deploy` job `needs: [build, integration, migrate]`).

### One-time manual setup (you do this once)

1. **Create the Render service** from the Blueprint (section A below): Render
   dashboard > **New +** > **Blueprint** > pick this repo. Render reads
   [`render.yaml`](render.yaml) (which has `autoDeploy: false`, so Render will
   *not* redeploy on its own native push — the CI hook is the only trigger).
2. **Set the API runtime secrets** in Render when prompted for the `sync: false`
   vars (full instructions in section A3):
   - `DATABASE_URL`
   - `FASTAPI_SUPABASE_URL`
   - `FASTAPI_SUPABASE_JWKS_URL`
   - `FASTAPI_SUPABASE_JWT_ISSUER`
   - `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN`
   - `FASTAPI_BACKEND_CORS_ORIGINS` (set later in section C, after Pages exists)
3. **Copy the Deploy Hook URL**: in the Render dashboard open the `margen-api`
   service > **Settings** > **Deploy Hook**. It looks like
   `https://api.render.com/deploy/srv-XXXX?key=YYYY`. Treat it as a secret — anyone
   with this URL can trigger a deploy.
4. **Add it as a GitHub Actions secret**: repo **Settings** > **Secrets and
   variables** > **Actions** > **Secrets** > **New repository secret**:
   - Name: `RENDER_DEPLOY_HOOK_URL`
   - Value: the Deploy Hook URL from step 3.
5. **Add the migration target secret** (so CI applies Alembic migrations to
   Supabase before each deploy): same screen > **New repository secret**:
   - Name: `SUPABASE_DATABASE_URL`
   - Value: the Supabase **direct / session-mode** connection string with the
     asyncpg driver — `postgresql+asyncpg://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
     (Supabase dashboard > Project Settings > Database > Connection string >
     "Session pooler"; prefix the scheme with `+asyncpg`). Treat it as a secret —
     it embeds the database password.
   - **Use 5432, not the transaction pooler (port 6543).** The transaction
     pooler (PgBouncer in transaction mode) does not support the prepared
     statements / session state that Alembic's DDL transactions rely on, so
     migrations can fail or misbehave on 6543. The migrate job needs the
     direct/session connection; only this one env var (`DATABASE_URL`) is
     required because Alembic's `migrations/env.py` resolves the URL solely from
     `DatabaseSettings().URL`.

That's it. Until `RENDER_DEPLOY_HOOK_URL` is set, the deploy job is a safe no-op
(it logs a skip and passes); likewise, until `SUPABASE_DATABASE_URL` is set the
migrate job is a safe no-op. A skipped migrate does not block deploy (a skipped
`needs` dependency counts as satisfied), so the workflow is green for
forks/contributors without access — same pattern as the keep-alive and capture
crons.

### What's automated after that

```
push to main (touching apps/api/**, render.yaml, DEPLOY.md, or api.yml)
  -> CI runs: build (lint + pip-audit + 100% coverage + docker build)
  -> CI runs: integration (real Postgres + Alembic + integration tests)
  -> both green? migrate job runs `alembic upgrade head` against Supabase
  -> migrate green? deploy job POSTs the Render Deploy Hook
  -> Render rebuilds the Docker image and redeploys margen-api
```

Migrations run **before** the deploy (schema-before-code): the Render rebuild
fires only after Supabase is at `head`, so the new image never boots against an
unmigrated schema. A red build/integration/migrate run skips the deploy job
entirely — nothing reaches the live service. A `concurrency` guard keeps
overlapping pushes from stacking redundant Render rebuilds. Pull requests run
`build` + `integration` but never migrate or deploy (`if: push && ref == main`).

> Database migrations are now applied automatically by the `migrate` job on each
> push to `main`, before the deploy fires — you no longer run `make migrate` by
> hand for the deploy path (this amends the prior manual-migration note). The
> job uses the `SUPABASE_DATABASE_URL` secret (the direct/session-mode connection
> string; see the one-time setup step 5 and the port-6543 caveat). When that
> secret is unset the migrate job is a safe no-op and does not block deploy.

### Frontend (no GitHub Actions needed)

Cloudflare Pages has its **own native git integration**: once you connect the repo
in the Pages dashboard (section B), it auto-builds and deploys `apps/web` on every
push to `main` on its own. There is no GitHub Actions deploy workflow for the
frontend — the only one-time action is connecting the repo in the Pages dashboard.

### Manual vs automated summary

| Action | Who/what | When |
| ------ | -------- | ---- |
| Create Render service from Blueprint | You (Render dashboard) | Once |
| Set API runtime secrets in Render | You (Render dashboard) | Once (+ on change) |
| Copy Render Deploy Hook URL | You (Render dashboard) | Once |
| Add `RENDER_DEPLOY_HOOK_URL` GH secret | You (GitHub Settings) | Once |
| Add `SUPABASE_DATABASE_URL` GH secret | You (GitHub Settings) | Once (+ on change) |
| Connect repo to Cloudflare Pages | You (Pages dashboard) | Once |
| API CI (lint + coverage + integration) | GitHub Actions | Every push/PR to `apps/api` |
| Apply DB migrations (`alembic upgrade head`) | GitHub Actions (`migrate` job) | On green CI, push to `main` |
| API deploy (POST Render hook) | GitHub Actions | After migrate, push to `main` |
| API rebuild + redeploy | Render (via hook) | When hook fires |
| Frontend build + deploy | Cloudflare Pages | Every push to `main` |

---

## A. Render — create the API service

1. Push this repo to GitHub (the Blueprint lives at the repo root).
2. In the Render dashboard: **New +** > **Blueprint** > select this repository.
   Render reads [`render.yaml`](render.yaml) and proposes the `margen-api` web
   service (Docker runtime, free plan, `rootDir: apps/api`,
   `healthCheckPath: /readiness`).
3. Render prompts for every `sync: false` env var. Set the secrets now:
   - `DATABASE_URL` — Supabase **session pooler** URL with the asyncpg driver:
     `postgresql+asyncpg://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
     (Supabase dashboard > Project Settings > Database > Connection string >
     "Session pooler"; prefix the scheme with `+asyncpg`).
   - `FASTAPI_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `FASTAPI_SUPABASE_JWKS_URL` — `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
   - `FASTAPI_SUPABASE_JWT_ISSUER` — `https://<ref>.supabase.co/auth/v1`
   - `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN` — a long random string (also used by the
     capture cron, ADR-064). Generate one, store it in the repo secret too (step E).
   - `FASTAPI_BACKEND_CORS_ORIGINS` — **leave blank for now**; set it in step C
     once the Pages origin exists.
4. Deploy. Wait until the service is healthy (`/readiness` returns 200, which
   requires `DATABASE_URL` to be reachable).
5. **Copy the service URL**, e.g. `https://margen-api.onrender.com`. You need it
   in steps B and E.

> Database migrations: this Blueprint does not run Alembic during the Render
> build. Instead the CI `migrate` job applies `alembic upgrade head` against
> Supabase before each deploy (see "Deployment & CI/CD" above), using the
> `SUPABASE_DATABASE_URL` secret. For the **very first** deploy — before any CI
> run has migrated the fresh database — you may still want to apply
> `uv run alembic upgrade head` once manually against the Supabase
> direct/session connection (port 5432, not the 6543 transaction pooler) so
> `/readiness` can come up.

---

## B. Cloudflare Pages — create the web project

1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Pages** >
   **Connect to Git** > select this repository.
2. Build settings:
   - **Production branch**: `main`
   - **Root directory**: `apps/web`
   - **Build command**: `corepack enable && pnpm install --frozen-lockfile && pnpm build`
   - **Build output directory**: `dist`
   - **Environment variable** `NODE_VERSION` = `22` (matches the `@types/node`
     v24 toolchain; pnpm is pinned to 10.12.4 via `packageManager`, activated by
     corepack).
3. Add the build-time `VITE_*` environment variables (Pages > Settings >
   Environment variables, Production):
   - `VITE_API_BASE_URL` — the Render URL from step A, **without** the `/api/v1`
     suffix (e.g. `https://margen-api.onrender.com`). `config.ts`'s `apiUrl()`
     appends `/api/v1` itself — do not include it here.
   - `VITE_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` — the Supabase **anon/publishable** key (browser-safe,
     ADR-093). Never the service-role key. Set it in the dashboard, not committed.
4. Deploy. **Copy the Pages URL**, e.g. `https://margen.pages.dev`.

The committed [`apps/web/public/_redirects`](apps/web/public/_redirects) rule
(`/*  /index.html  200`) is what makes TanStack Router deep links resolve on
Pages instead of 404ing.

---

## C. Cross-wiring (order matters)

1. **API first** (step A) — gives you the Render URL.
2. Put the Render URL (no `/api/v1`) into Pages `VITE_API_BASE_URL` (step B3) and
   deploy Pages — gives you the Pages origin.
3. **Back in Render**, set `FASTAPI_BACKEND_CORS_ORIGINS` to the Pages origin
   (e.g. `https://margen.pages.dev`) — comma-separated, no quotes/brackets, no
   wildcard (ADR-006). Save; Render redeploys. Add the custom domain origin too
   if you map one.

Summary: deploy API -> copy URL into Pages -> deploy Pages -> copy origin into
Render CORS.

---

## D. Supabase — allow the Pages origin for auth

In the Supabase dashboard > **Authentication** > **URL Configuration**:

- **Site URL**: the Pages origin (e.g. `https://margen.pages.dev`).
- **Redirect URLs**: add the Pages origin (and any custom domain) so the OAuth
  redirect returns to the deployed frontend.

Without this, the Supabase auth handshake will reject the redirect back to the
deployed app.

---

## E. Keep-alive cron

[`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml) curls
`/<base>/readiness` twice a week. `/readiness` runs `SELECT 1`, so one ping keeps
both the Render process and the Supabase DB from going idle.

- Set the repo **variable** `KEEPALIVE_API_BASE_URL` to the Render URL
  (Settings > Secrets and variables > Actions > Variables). The workflow is a
  no-op until this is set.

Also configure the existing Monotributo capture cron
([`.github/workflows/monotributo-capture.yml`](.github/workflows/monotributo-capture.yml),
ADR-065) — set the repo **secrets** `MONOTRIBUTO_API_BASE_URL` (Render URL) and
`MONOTRIBUTO_CAPTURE_TOKEN` (the same value as Render's
`FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN`).

---

## Free-tier caveats

- **Render sleep**: the free web service sleeps after ~15 min idle; the next
  request triggers a cold start (~50s). The weekly keep-alive prevents the
  project from being *paused*, but does not eliminate per-idle cold starts.
- **Supabase pause**: free projects pause after 7 days of inactivity. The
  twice-weekly readiness ping (which hits Postgres) keeps it active.
- **First request after idle** can therefore be slow — acceptable for this scope.
