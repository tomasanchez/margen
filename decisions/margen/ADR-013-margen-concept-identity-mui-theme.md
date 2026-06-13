---
project: margen
adr: 013
title: Adopt the Margen concept identity as the MUI theme (dark + light)
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-013: Adopt the Margen concept identity as the MUI theme (dark + light)

## Context

The concepts define a strong visual identity (warm dark, gold accent, Safe/Watch/Risk semantics, Hanken Grotesk + IBM Plex Mono numerals). The app must honor it but stay on our MUI component approach rather than the concept's hand-rolled inline styles. A placeholder slate-blue MUI theme exists from issue #1 (see ADR-005).

## Decision

Encode the concept's identity as the MUI theme and build all UI with MUI components. Palette — primary GOLD #c7a253 (dark text #141310 on gold); semantic SAFE #6dae8d / WATCH #d8a23f / RISK #c8694f; dark surfaces page #1a191c, panels #141310/#181610/#1a1813, borders #211f19/#2c2922; text #f1eee6/#a39e93/#6e6a60. Typography — Hanken Grotesk for UI, IBM Plex Mono (tabular-nums) for all financial numbers; uppercase letterspaced eyebrow labels. Ship BOTH dark and light palettes (light: page #f3f0e9, white cards, gold #8c7026, green #4e8a6b) with an MUI color-mode toggle, dark as default.

## Alternatives Considered

- **Keep the slate-blue placeholder theme, adopt layout only**: Diverges from the product's intended look; the concept identity is a deliberate product decision — not chosen.
- **Hand-roll inline styles like the concept HTML**: Abandons MUI theming/components, hurting consistency and maintainability — not chosen.
- **Dark-only**: A light palette is already designed; the user chose to ship the toggle now — not chosen.

## Consequences

Replaces the placeholder slate-blue theme from ADR-005 (this evolves the stack's theme; it does not contradict ADR-005's stack decision). Theme tokens (palette, typography, shape, component overrides) become the single styling source. Both modes must be QA'd.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
