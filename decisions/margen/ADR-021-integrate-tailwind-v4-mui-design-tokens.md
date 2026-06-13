---
project: margen
adr: 021
title: Integrate Tailwind CSS v4 with MUI via shared design tokens
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-021: Integrate Tailwind CSS v4 with MUI via shared design tokens

## Context

Issue #12 calls for Tailwind v4 utility classes alongside MUI — including color utilities (not just layout/spacing). MUI provides the component layer and theme (the product's look and feel, established in ADR-013); Tailwind v4 adds utility classes on top. The two styling systems must coexist without CSS cascade-order conflicts, and the Margen concept palette (gold, Safe/Watch/Risk, surfaces, text — ADR-013) must not drift between them.

## Decision

Integrate Tailwind v4 using MUI's official integration. Vite setup: add the `@tailwindcss/vite` plugin and `@import "tailwindcss";` in the global stylesheet. Coexistence: wrap the app in `<StyledEngineProvider enableCssLayer>` and emit a `GlobalStyles` rule `@layer theme, base, mui, components, utilities;` so the `mui` layer precedes `utilities`, letting Tailwind classes override MUI when intentional.

Single source of truth for color: define the Margen palette (gold, Safe/Watch/Risk, surfaces, text) once as CSS custom properties (design tokens). The MUI theme palette reads those variables AND Tailwind's `@theme` block maps its color utilities to the same variables. Dark/light mode is handled by swapping token values per color mode. Colors are therefore usable from either system but defined exactly once.

## Alternatives Considered

- **Tailwind for layout/spacing utilities only (MUI owns all color)**: The user chose to also map brand/semantic colors into Tailwind so utility classes can carry full design meaning — not chosen.
- **Skip Tailwind, pure MUI (sx/styled)**: The user explicitly requested Tailwind via the supported MUI integration — not chosen.
- **Define colors separately in MUI theme and in Tailwind config**: Two independent color definitions drift over time; shared CSS-variable tokens eliminate that risk — not chosen.

## Consequences

Two styling systems coexist but share one token source, keeping brand/semantic colors consistent across MUI components and Tailwind utilities. Adds `tailwindcss` and `@tailwindcss/vite` to the frontend dependency set. Requires verifying the cascade-layer order (`mui` before `utilities`) in browser devtools. Contributors may style via MUI `sx`/`theme` OR Tailwind `className`; semantic meaning lives in the tokens, not in ad-hoc hex values. Slightly more setup and two mental models to maintain.

Relates to ADR-013 (Margen palette and MUI theme are the authoritative identity layer that this ADR extends with token-sharing) and ADR-016 (frontend conventions; `src/theme/*` is the natural home for the shared CSS-variable token definitions).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
