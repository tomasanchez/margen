---
project: margen
adr: 017
title: Responsive layout patterns and preserved concept UX
category: ux
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-017: Responsive layout patterns and preserved concept UX

## Context

The concepts define distinct desktop and mobile patterns and several strong UX decisions to preserve.

## Decision

Desktop: top bar with month switcher + left sidebar nav + gold "Add transaction" CTA. Mobile: bottom navigation with a center FAB and a scrolling content area. The Add/Edit flow is a centered MUI Dialog on desktop and a bottom-anchored Drawer (sheet) on mobile, sharing one form; the Transactions mobile filters use the same bottom-sheet pattern. Preserve: ONE primary status message on Home (Safe/Watch/Risk + headline + supporting line), large readable tabular numbers, compact insight cards (not a wall of charts), clear FX context on USD rows/cards (converted ARS + rate type MEP + rate value + edit affordance), and Monotributo status as a confidence-building card (category, % of annual limit, projected category, margin left).

## Alternatives Considered

- **Centered Dialog on all viewports**: Less natural on mobile than the concept's sheet — not chosen.
- **Redesign layouts**: The concept's decisions are deliberate and validated as the product direction — not chosen.

## Consequences

Consistent responsive behavior matching the concept. Shared Add/Edit form reduces duplication. Edit prefills the same Add form. The bottom-sheet pattern for both the form and filters is a reusable interaction pattern.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
