---
project: margen
adr: 172
title: Mobile navigation — hamburger drawer for full nav + slimmed bottom pill
category: ux
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-172: Mobile navigation — hamburger drawer for full nav + slimmed bottom pill

## Context

The mobile floating bottom pill had grown to six items: Home, Transactions, Accounts, Budgets, Reports, and (when the settings gate is enabled) Monotributo. Beyond five items a bottom pill becomes cramped, and two tools — Transfers and Import — were entirely absent from mobile; they were reachable only via the desktop sidebar. This created a parity gap where mobile users could not access Import or Transfers at all.

The underlying navigation information architecture is defined in ADR-127. The floating shell pattern adopted in ADR-017 did not anticipate the nav growing to this size. ADR-019 governs the non-color active-state cues that must be preserved in any new navigation surface. ADR-126 defines the optional-module gating that applies to the Monotributo entry.

Note: early code comments referenced this decision as "ADR-160"; ADR-160 is actually the reimbursement net-category-spend record. Those references have been corrected in code. ADR-172 is the authoritative record for this decision.

## Decision

On `xs` viewports (mobile):

- The top-left **brand mark is replaced by a floating Menu (hamburger) button**. Tapping it opens a temporary **left Drawer** containing the full navigation, mirroring the desktop sidebar in structure:
  - Primary peers: Home, Transactions, Accounts, Budgets, Reports.
  - Tools group: Transfers, Import, and (settings-gated) Monotributo.
  - Add-transaction CTA.
  - Brand header inside the drawer.
- The drawer is **temporary** (overlays content, does not push it). It closes on: item tap, backdrop tap, Escape key, or route change.
- Accessibility: the hamburger button carries `aria-haspopup="true"`, `aria-expanded`, and `aria-controls` pointing to the drawer; the drawer implements a **focus trap** while open.
- The floating **bottom pill is slimmed to three items**: **Home, Transactions, Reports** — the three highest-frequency destinations identified by the owner.

On `md+` viewports (desktop), the persistent sidebar is **unchanged** — it already exposes the full navigation.

A new `NavDrawer` component is introduced. Navigation constants, `SidebarNavLink`, and `BrandMark` are lifted into a shared module consumed by both the drawer and the sidebar to avoid duplication.

## Alternatives Considered

- **Expand the pill to 7–8 items with smaller icons**: Bottom pills degrade quickly past five items on typical phone widths; touch targets shrink below accessible minimums; rejected.
- **Replace the pill entirely with a bottom tab bar (fixed, always visible)**: Accommodates more items but still caps out around five before becoming unreadable; does not resolve the Transfers/Import absence; rejected.
- **Hamburger-only — remove the bottom pill entirely**: Removes the quick-access shortcut for the most-used destinations; increases tap count for the majority use case (Home ↔ Transactions ↔ Reports daily loop); rejected.
- **Keep Transfers/Import desktop-only with a note**: Leaves a permanent mobile parity gap for users who import on mobile; rejected given that the drawer imposes no additional engineering cost once built.

## Consequences

- **Accounts, Budgets, and Monotributo move off the pill** into the drawer. Users who relied on the pill for those destinations will need one extra tap (open drawer → tap item).
- **Transfers and Import are reachable on mobile for the first time** — full parity with desktop navigation.
- A new `NavDrawer` component is introduced; shared nav constants and `SidebarNavLink`/`BrandMark` are extracted for reuse.
- The drawer's close-on-route-change behaviour relies on TanStack Router's location signal — this must be wired correctly or the drawer will remain open after navigation (a regression risk).
- Focus trap in the drawer must be verified across screen readers (VoiceOver/iOS, TalkBack/Android) to satisfy the a11y commitment in ADR-019.
- When a new primary-nav destination is added in future, the author must update the drawer (and optionally the pill if it is a top-3 destination) — a single canonical nav-items constant mitigates this maintenance surface.
- Relates to ADR-017 (floating mobile shell — pill pattern adopted here; pill now slimmed), ADR-019 (non-color active cues — must be preserved in the drawer), ADR-126 (Monotributo optional-module gating — drawer entry respects the same gate), ADR-127 (nav IA — drawer structure mirrors the sidebar defined there).

## Status History

- 2026-07-02: accepted
