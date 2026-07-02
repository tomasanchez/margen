---
project: margen
adr: 170
title: Monotributo trajectory panel reuses trailing-12 reader; forward projection deferred to Slice 4
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-170: Monotributo trajectory panel reuses trailing-12 reader; forward projection deferred to Slice 4

## Context

The redesigned Reports page (ADR-167) includes a Monotributo trajectory panel. The original plan (ADR-129) envisioned a forward projection engine: "if current invoicing pace continues, you will cross the category ceiling around month X." The existing Monotributo reader (ADR-046/ADR-047) already computes the trailing-12-month turnover against the current category ceiling — it was built precisely for this purpose and is already consumed by the Home card and the Monotributo page.

Building the forward projection now ("projected next 12 months / crosses ceiling around <month>") requires extrapolating monthly income run-rates, handling seasonality, and reasoning about the Monotributo scale update cadence (ADR-067). This scope is material and belongs in its own slice (Slice 4, as flagged in ADR-129).

The panel the owner needs now — am I approaching my annual ceiling? — is fully answerable with the trailing-12 reader alone.

## Decision

The Monotributo trajectory panel on the Reports page is served by the **existing `GET /api/v1/monotributo` reader** (ADR-046/ADR-047) with no changes to the backend.

The panel displays:

- **Invoiced last 12 months** — the trailing turnover figure already returned by the reader.
- **Current category ceiling** — the category threshold for the user's configured Monotributo category (ADR-053/ADR-067).
- **Progress bar / percentage** — invoiced ÷ ceiling, surfacing how close the user is to the limit.

The following are **explicitly out of scope for this slice:**

- "Projected next 12 months" extrapolation.
- "Crosses the ceiling around <month>" forward estimate.
- Any new SQL or backend endpoint for this panel.

The forward projection is deferred to Slice 4 and was already flagged as future work in ADR-129.

## Alternatives Considered

- **Build the forward projection now**: Requires monthly income run-rate extrapolation, seasonality handling, and alignment with the scale update cadence (ADR-067) — significant modeling work that is not justified by the panel's core value proposition (ceiling awareness); deferred.
- **New dedicated reports endpoint for Monotributo data**: Wraps the same trailing-12 reader in a reports-namespaced endpoint — adds an endpoint with no new logic; the existing reader is already owner-scoped and returns exactly the needed data; rejected.
- **Drop the panel entirely from this slice**: The trailing-12 data is already available with zero new backend work; deferring the panel entirely would remove high-value freelancer context from the page for no reason; rejected.

## Consequences

- Zero new backend work for this panel — the reader is already production-ready.
- The panel is visually prominent (a freelancer's ceiling proximity is a top-of-mind concern) but scope-light for this slice.
- When Slice 4 builds the forward projection, it will extend the Monotributo reader or add a separate projection endpoint; the panel component will be extended in place.
- Relates to ADR-046 (trailing-12 turnover calculation), ADR-047 (Monotributo reader pattern), ADR-053 (Monotributo category in app settings), ADR-067 (versioned scale registry), ADR-129 (forward projection — deferred), ADR-167 (reports redesign that includes this panel).

## Status History

- 2026-07-02: accepted
