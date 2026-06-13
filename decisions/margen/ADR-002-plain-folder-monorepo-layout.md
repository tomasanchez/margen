---
project: margen
adr: 002
title: Plain-folder monorepo layout (no workspace manager)
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-002: Plain-folder monorepo layout (no workspace manager)

## Context

The repo hosts two apps with different ecosystems (Python and JS). The issue asks to keep tooling simple and easy to run on Windows.

## Decision

Use a plain-folder monorepo: apps/api managed by uv, apps/web managed by npm, with root-level README.md and .gitignore. No pnpm/Turborepo/Nx workspace manager.

## Alternatives Considered

- **pnpm workspaces**: Only one JS app exists; workspace management adds tooling with no current benefit — not chosen.
- **Turborepo/Nx**: Task orchestration and caching is overkill for a two-app foundation and adds config to maintain — not chosen.

## Consequences

Each app keeps its own toolchain and lockfile; no cross-app dependency hoisting. A workspace manager can be added later if more JS packages appear.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
