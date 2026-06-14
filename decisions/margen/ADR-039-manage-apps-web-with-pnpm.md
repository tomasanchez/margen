---
project: margen
adr: 039
title: Manage apps/web with pnpm
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-039: Manage apps/web with pnpm

## Context

ADR-002 put `apps/web` on npm because it was the only JS package at the time. The team now wants pnpm's strict, content-addressed `node_modules` (eliminates phantom dependencies), faster installs and disk savings via the global content-store, and readiness for future JS packages or workspaces. This changes the JS package manager within ADR-002's plain-folder monorepo and moves the esbuild override mechanism established by ADR-022 from npm `overrides` to `pnpm.overrides`.

## Decision

Manage `apps/web` with pnpm, pinned via corepack (a `"packageManager": "pnpm@<version>"` field in `apps/web/package.json`). Replace `package-lock.json` with `pnpm-lock.yaml`. Migrate the esbuild security pin from npm `overrides` to `pnpm.overrides` (`"esbuild": "^0.28.1"`), keeping the ADR-022 remediation intact and verified (`pnpm audit` = 0 high; esbuild resolves to 0.28.1). Update the Web CI workflow (`.github/workflows/web.yml`) to use pnpm: corepack/pnpm setup, `pnpm install --frozen-lockfile`, a pnpm audit gate (fail on high), and `pnpm run lint/build/test`, with pnpm caching. The plain-folder monorepo (ADR-002) and per-app toolchains stand (uv for `apps/api`, pnpm for `apps/web`); no root JS workspace yet — revisit when a second JS package appears.

## Alternatives Considered

- **Stay on npm**: The team chose pnpm's strictness and speed now; npm's only edge (bundled with Node) is mitigated by corepack — not chosen.
- **pnpm workspaces at the repo root now**: There is still only one JS package; a workspace would coordinate nothing — premature (YAGNI). Add it when a second JS package lands — not chosen.

## Consequences

Contributors and CI need pnpm, provisioned via corepack and the `packageManager` field (low friction). pnpm's strict `node_modules` may surface phantom-dependency errors (a package used but not declared in `package.json`) — these are fixed by declaring the missing deps explicitly (preferred) rather than disabling strictness. The esbuild override now lives under `pnpm.overrides` and must be re-validated on Vite/Vitest upgrades (per ADR-022). The lockfile is `pnpm-lock.yaml`. Amends ADR-022 (override mechanism moves from npm `overrides` to `pnpm.overrides`) and changes the `apps/web` package manager from ADR-002 (whose plain-folder layout otherwise stands).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
