---
project: margen
adr: 178
title: Forecast surfaces as a Reports panel first; dedicated route and nav item deferred behind demonstrated need
category: ux
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-178: Forecast surfaces as a Reports panel first; dedicated route and nav item deferred behind demonstrated need

## Context

The forecast engine (ADR-176) needs a frontend consumer. Two surface options exist: embed a panel on the existing Reports page (ADR-167) or add a dedicated `/forecast` route with its own nav item. Adding a nav item increases the information architecture (ADR-127) and the mobile navigation surface (ADR-172); this cost is only worth paying once the feature has demonstrated sustained engagement.

## Decision

The cash-flow forecast is surfaced as a **panel on the Reports page** (ADR-167) in Slice 4. No new top-level route, no new nav item.

The panel:
- Calls `GET /api/v1/forecast` (ADR-176) using the page's existing preferred-currency context.
- Renders a per-month committed outflow chart or table for the configured horizon (default 3 months).
- Displays the monotributo stream (ADR-177) distinctly with its ARS-fixed caveat when the page currency is USD.

A dedicated `/forecast` route and nav item are **deferred** behind demonstrated need. Triggers that would justify promotion:
- The owner uses the panel regularly and asks for deeper controls (horizon picker, stream toggles, discretionary band).
- A discretionary band (the estimated confidence tier from ADR-176) is added, making the panel complex enough to warrant its own page.

## Alternatives Considered

- **Dedicated `/forecast` route from day one**: Premature promotion for an unvalidated feature; adds a nav item to an already-full sidebar (ADR-172 notes the nav is already at capacity) before engagement is confirmed; rejected.
- **Home dashboard card**: The Home card is optimized for at-a-glance summaries (current month only); a multi-month projection chart does not fit the card format; rejected for the initial surface.
- **Standalone modal triggered from Reports**: Avoids a route but makes the feature invisible and hard to share; rejected.

## Consequences

- Zero new routes, zero nav changes — the Reports page absorbs the panel with no IA cost.
- If the panel proves high-value, promoting it to a dedicated route is a one-ADR decision; the backend contract (ADR-176) is already route-agnostic.
- The Reports page (ADR-167) gains a dependency on `GET /forecast`; the page's loading state must handle a second async call gracefully.
- Relates to ADR-127 (nav IA — no new item added here), ADR-167 (Reports page — panel is added here), ADR-172 (mobile nav — not changed by this ADR), ADR-173 (commitment-driven forecast), ADR-176 (engine and API contract), ADR-177 (monotributo stream rendered in this panel).

## Status History

- 2026-07-02: accepted
