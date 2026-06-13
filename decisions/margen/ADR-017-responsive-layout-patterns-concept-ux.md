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

## Update — 2026-06-13: shell refinements toward an iOS feel

After reviewing the running prototype, the shell was refined (still honoring the concept's strong decisions above):

- **Fixed-viewport single scroll.** The shell owns exactly `100dvh` with `overflow: hidden`; the window never scrolls — only the `<main>` content area scrolls. The header and (mobile) bottom nav are non-scrolling.
- **Centered content.** The routed content is capped at a max width (~1240px) and centered, so wide screens get balanced side margins while the header/sidebar stay full width.
- **Account menu.** The top-bar avatar opens an account surface: a dropdown **Menu** on desktop, a **full-screen right Drawer** on mobile (rows are `MenuItem` in the Menu but `ListItemButton` in the Drawer — `MenuItem` requires a `MenuList` parent). It shows a mock user (name + email), the **theme (dark/light) toggle** (moved here from the toolbar), and inert **Settings** + **Sign out** placeholders (settings/auth are non-goals — ADR-012). Settings was therefore **removed from the nav** to avoid duplication.
- **Nav icons.** Sidebar and mobile nav render real icons (filled when active + gold + `aria-current`, outlined/muted when inactive) instead of marker squares.
- **iOS mobile navigation.** The mobile bottom nav is a **floating, icon-only capsule pill** (centered, detached from the edges, soft shadow/blur), with a **separate round gold ＋ FAB** floating at the bottom-right. Both are fixed overlays; `<main>` reserves bottom clearance.
- **Mobile top bar.** Transparent **fixed overlay** so content scrolls *beneath* it (true see-through). Left shows only the brand icon (wordmark hidden on mobile); the right cluster is a floating circular **calendar button** (opens a compact month picker) + the avatar. The month selection state is shared between the desktop stepper and the mobile picker (cosmetic for now). Desktop keeps a **solid `background.paper`** bar whose bottom border uses the same `--mg-border` token as cards (not the heavier `divider`).
- **Accessibility (ADR-019).** Status/active cues never rely on color alone; sr-only text uses MUI's `visuallyHidden` (a hand-rolled helper using `width: 1` was actually `100%` in MUI `sx` and caused horizontal overflow on Home — see ADR-020 edge handling).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
- 2026-06-13: updated — iOS-style shell refinements (fixed-viewport scroll, centered content, account menu, floating mobile nav, transparent mobile top bar)
