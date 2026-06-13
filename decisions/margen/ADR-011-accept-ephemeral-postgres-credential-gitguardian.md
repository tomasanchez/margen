---
project: margen
adr: 011
title: Accept ephemeral Postgres credential flagged by GitGuardian
category: security
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-011: Accept ephemeral Postgres credential flagged by GitGuardian

## Context

GitGuardian's PR scan flagged a "Generic Password" (incident 33965783) — `POSTGRES_PASSWORD: margen-api` — first detected in the now-deleted `apps/api/.github/workflows/build.yml`. The same value is the cosmic-fastapi template convention (user = password = db = project slug `margen-api`) and appears by design in `database_settings.py`, `docker-compose.yaml`, the CI integration job (`.github/workflows/api.yml`), and the `.env.example` / README docs.

## Decision

Treat this as a false positive and accept the value. It only protects a disposable CI service container (destroyed after each run) and a local docker-compose database bound to localhost — neither is internet-reachable. It is not a production credential and there is no service to rotate. Real deployments override `DATABASE_URL` via environment variables (ADR-007).

Remediation steps:

1. Resolve GitGuardian incident 33965783 as a false positive in the dashboard.
2. Add a repo-root `.gitguardian.yaml` that ignores the `margen-api` match (documented as an ephemeral dev/CI credential) so `ggshield`/pre-commit scans stop flagging it.

## Alternatives Considered

- **Rotate/replace the credential everywhere**: Most churn for a throwaway local/ephemeral database; the local settings default still needs some value, and there is no production service behind it to compromise — not chosen.
- **Parameterize the CI password via a GitHub Actions secret only**: Reduces the CI footprint but the same value still lives in docker-compose, the settings default, and examples, so scanners would keep flagging those — a partial fix with more moving parts — not chosen.
- **Rewrite git history to purge the deleted build.yml line**: Pointless — the value legitimately persists in `api.yml`, `docker-compose.yaml`, `database_settings.py`, and examples and is non-sensitive, so history rewriting would be disruptive with no security benefit — not chosen.

## Consequences

The flagged value remains in the repo as an intentional, documented non-secret. A `.gitguardian.yaml` ignore prevents future `ggshield` noise; the dashboard incident is resolved as a false positive. Contributors who see the same alert have a recorded rationale here.

Mild residual code smell: `database_settings.py` embeds a credentialed default URL (template design), acceptable because it is a local-only default overridden by env in real environments (ADR-007).

If production credentials are ever introduced, they MUST come from env/secrets and never be committed — reaffirming ADR-007. See ADR-004 for the PostgreSQL/docker-compose setup this credential belongs to, and ADR-010 for the CI integration job (`api.yml`) where it also appears.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
