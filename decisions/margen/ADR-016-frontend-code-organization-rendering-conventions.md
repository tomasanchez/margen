---
project: margen
adr: 016
title: Frontend code organization and rendering conventions
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-016: Frontend code organization and rendering conventions

## Context

The prototype spans two feature areas plus shared shell, formatting, and visualizations; conventions should scale into real product work.

## Decision

Use feature-based folders: `src/features/home/*`, `src/features/transactions/*` (components + hooks), `src/components/*` (shell, nav, Amount, StatusPill, etc.), `src/theme/*`, `src/mock/*` (seed + mock async API), `src/lib/format.ts`. Self-host fonts via `@fontsource` (hanken-grotesk + ibm-plex-mono). Build trend bars and category bars with MUI/CSS (Box) and the Monotributo meter with a themed LinearProgress — NO charting library (honors the 'no complex charting' non-goal). Centralize money rendering in `src/lib/format.ts` (es-AR ARS `1.234,56`, USD, signed, deltas) plus a reusable `<Amount>` component (IBM Plex Mono, tabular-nums, income green / expense neutral, optional FX subline).

## Alternatives Considered

- **Flat by-type folders**: Mixes Home/Transactions concerns as the app grows — not chosen.
- **Google Fonts CDN**: External render-blocking request; `@fontsource` is offline, deterministic in CI, faster — not chosen.
- **Recharts**: Overkill for simple bars and against the non-goal of no complex charting — not chosen.
- **Inline Intl.NumberFormat per call site**: Invites inconsistent styling/sign/color across screens — not chosen.

## Consequences

One styling/format source of truth; no chart dependency; offline-capable fonts. Establishes folder structure that future issues extend without reorganization.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
