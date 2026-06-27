---
project: margen
adr: 118
title: Auto-apply Alembic migrations in CI before the Render deploy
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-118: Auto-apply Alembic migrations in CI before the Render deploy

## Context

Per ADR-099, Alembic migrations against Supabase were applied **manually** (`uv run --env-file .env alembic upgrade head`) as a step separate from the CI deploy flow. The `.github/workflows/api.yml` pipeline ran: build + integration gate → Render Deploy Hook — with no migration step in between.

This ordering was error-prone: code could reach the live Render container before its migration was applied, meaning the new binary ran against an older schema. The failure mode was hit in practice: the ADR-117 `bank`/`card` column split deployed before its Alembic migration was manually applied, temporarily breaking the live API.

Alembic's `env.py` resolves the database URL from `DatabaseSettings().URL`, so a CI migration step requires only a `DATABASE_URL`-equivalent secret — no other application settings.

## Decision

Add a **`migrate`** job to `.github/workflows/api.yml` that runs `alembic upgrade head` against Supabase on every push to `main`. The job is gated with `needs: [build, integration]` so it only fires after the full test suite passes. The Render **`deploy`** job is updated to `needs: [build, integration, migrate]`, enforcing schema-before-code ordering: the database is migrated before new application code goes live on Render.

The Supabase connection string is stored as a `SUPABASE_DATABASE_URL` GitHub Actions secret. It must be the **direct/session-mode** `postgresql+asyncpg://` URL on port 5432 — **not** the transaction pooler on port 6543, which breaks DDL statements under asyncpg.

Both the `migrate` and `deploy` jobs use the same "configured-or-skip" guard already present on the deploy job: if the secret is absent (fork runs, PRs, pre-secret setup), the job exits green without doing anything. The workflow remains safe to merge before the secret exists.

## Alternatives Considered

- **Keep migrations manual (ADR-099 approach)**: The schema/code ordering bug described in the context is the direct reason for this change — retaining the manual process perpetuates it. Rejected.
- **Run migrations inside the Render service start command**: Couples migration to every container start and restart, runs under the app's pooled connection (transaction pooler / DDL incompatibility), and races when multiple instances start simultaneously. Rejected.
- **Let Render auto-deploy on git push with a pre-deploy migrate step in `render.yaml`**: `render.yaml` uses `autoDeploy: false` with the Deploy Hook as the sole trigger; adding a Render-side pre-deploy command would split the migration gate across two systems and lose the single-pane-of-glass CI pipeline. Rejected.

## Consequences

- **Amends ADR-099**: migrations are now automated as part of the CI deploy path rather than applied manually. The `DEPLOY.md` note about manual `make migrate` applies only to out-of-band or backfill runs.
- Adds a required `SUPABASE_DATABASE_URL` GitHub Actions secret for the live migrate path. When the secret is absent the `migrate` and `deploy` jobs skip green, preserving safe-to-merge behavior for forks and PRs.
- The Render deploy now waits on a successful `migrate` job; a migration failure blocks the deploy automatically.
- Forward-only Alembic migrations are applied to production automatically on every merge to `main`. A destructive or incorrect migration reaches Supabase without a manual gate — the `build` + `integration` jobs (which run migrations against a real Postgres) are the primary safety net.
- During the Render rebuild window, old application code runs briefly against the new schema. Schema changes that are not backward-compatible with the previous code version still require an expand/contract approach.
- The manual `alembic upgrade head` command remains available for out-of-band or backfill runs against any target database.
- Relates to ADR-099 (Render + Supabase deploy target, now amended), ADR-117 (bank/card column split — the migration ordering failure that motivated this change).

## Status History

- 2026-06-27: accepted
