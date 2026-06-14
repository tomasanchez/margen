---
project: margen
adr: 65
title: Schedule capture via a GitHub Actions monthly cron, parameterized and no-op until deployed
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-065: Schedule capture via a GitHub Actions monthly cron, parameterized and no-op until deployed

## Context

ADR-052 deliberately rejected in-process schedulers (Pydantic v1/Rocketry incompatibility; in-process schedulers duplicate triggers across replicas). GitHub issue #20 requires an external trigger that fires once per period, even if no user opens the page. No public API is deployed yet.

The Monotributo domain (ADR-046, ADR-048) uses a month-keyed snapshot history. ARCA recategorizes contributors in January and July, making those months particularly important to capture; but all months in between still need a scheduled snapshot to keep the history complete.

ADR-064 establishes the bearer-token guard that this workflow must satisfy.

## Decision

Add a GitHub Actions scheduled workflow under `.github/workflows/` that:

- Runs on a **monthly cron**: `0 0 1 * *` (00:00 UTC on the 1st of each month). This keeps the month-keyed snapshot history complete and naturally covers ARCA's January/July recategorization boundaries.
- Exposes a **`workflow_dispatch`** trigger for manual testing without waiting for the cron.
- Reads two values from repository secrets/variables:
  - `MONOTRIBUTO_API_BASE_URL` — the deployed API base URL.
  - `MONOTRIBUTO_CAPTURE_TOKEN` — the bearer token (matches `FASTAPI_MONOTRIBUTO_CAPTURE_TOKEN`, ADR-064).
- Includes a **guard step** that checks whether both values are set and skips (`continue-on-error: false` / early exit) when either is absent. This makes the workflow safe to merge now — it is inert until the API is deployed and secrets are configured.
- The actual capture step is a single `curl` (or equivalent) authenticated `POST` to `{BASE_URL}/api/v1/monotributo/capture` with `Authorization: Bearer <token>`.
- One scheduled run = one POST. Because capture is idempotent (ADR-052, keyed by `period_end`), accidental double-fires are safe.

## Alternatives Considered

- **Azure scheduled job / Container Apps job**: aligns with the eventual Azure deploy target but no Azure infra exists yet — speculative and unrunnable at this stage.
- **Kubernetes CronJob**: no cluster exists yet — equally speculative.
- **Semi-annual cadence (Jan/Jul only)**: months in between would receive no scheduled snapshot; monthly keeps the history complete and still covers the recategorization boundaries.
- **In-process scheduler**: rejected in ADR-052 (Pydantic v1/Rocketry incompatibility; replica duplication).

## Consequences

- The schedule is version-controlled alongside the code; cadence and endpoint are easy to change via a PR.
- The workflow is inert (skips) until `MONOTRIBUTO_API_BASE_URL` and `MONOTRIBUTO_CAPTURE_TOKEN` are set — no accidental fires against an undeployed API.
- Migrating to Azure/k8s scheduling later is a drop-in replacement of the trigger mechanism, not the endpoint or auth scheme.
- The workflow itself is not unit-tested (it is declarative); the skip-when-unset guard and YAML correctness are verified by inspection and a manual `workflow_dispatch` dry run once secrets exist.
- See ADR-064 for the bearer-token auth that this workflow satisfies, and ADR-066 for the fast-tier test coverage of the endpoint it calls.

## Status History

- 2026-06-14: accepted
