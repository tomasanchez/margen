---
project: margen
adr: 171
title: Net-worth panel dropped from Reports; deferred panels and rationale for getting-paid, inflation-adjusted spending, and PDF export
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-171: Net-worth panel dropped from Reports; deferred panels and rationale for getting-paid, inflation-adjusted spending, and PDF export

## Context

The redesigned Reports page concept (ADR-167) does not include a net-worth-over-time chart — the concept reframes the page around cash-flow and freelancer analytics, not balance-sheet evolution. Additionally, several panels the owner considered for future slices require new data modeling or external data sources that do not exist yet. Recording explicit deferrals with rationale prevents these from being re-raised informally without a plan.

ADR-164 defined the `GET /reports/net-worth-history` endpoint. It was built but the page redesign removes its consumer. The endpoint's existence and design decision should be preserved.

## Decision

### Net-worth-over-time panel

The net-worth-over-time line chart is **dropped from the Reports page** as part of the redesign (ADR-167). The concept layout has no such panel and the owner did not request it.

The `GET /api/v1/reports/net-worth-history` endpoint (ADR-164) is **retained** — it is a valid, working read model. It is available for a future "Accounts" or "Balance Sheet" page. No code is deleted.

### Deferred panels

The following panels were evaluated and explicitly deferred. Each requires its own future slice and plan before implementation.

---

**Getting-paid analytics** (avg days-to-pay, late payment count, client concentration)

- *What it needs:* A `client` or `payer` field on transactions (to group by counterparty) and an `issued_date` alongside `occurred_on` (to compute payment lag). Neither field exists in the current transaction model (ADR-024/ADR-026). `occurred_on` is the single date recorded; there is no distinction between invoice date and payment date.
- *Why deferred:* Adding `client` and `issued_date` requires a schema migration, a form change, and backfill decisions for existing transactions. This is a significant modeling decision in its own right, not a reports-layer concern.
- *Future slice:* Model the `client` field and dual-date capture first; getting-paid analytics follow naturally.

---

**Inflation-adjusted real spending** (nominal ARS spend deflated by monthly CPI index)

- *What it needs:* A monthly Argentine CPI (or IPC) index — either stored in a new `inflation_index` table (seeded from INDEC data) or fetched from an external API on the read path.
- *Why deferred:* No such data source is integrated; adding one requires an ADR covering source selection, update cadence, data reliability, and whether the index is fetched live or stored. The feature is high-value for an ARS-heavy user but is a new external dependency.
- *Future slice:* Decide and integrate the inflation index source; the spending chart gains a "real vs nominal" toggle.

---

**PDF for contador** (formatted PDF report for the accountant / tax preparer)

- *What it needs:* A new formatted-export endpoint producing a structured PDF (not a raw CSV). ADR-128 explicitly deferred PDF export to avoid adding a PDF-generation library (e.g., `reportlab`, `weasyprint`) before the page's data model was stable.
- *Why deferred:* The data model is still evolving (range-based redesign just adopted); a formatted PDF requires a stable schema, a template, and a new backend library. The CSV export (ADR-165) already satisfies the "hand something to the contador" use case at lower cost.
- *Future slice:* Once the reports data model stabilises, design the PDF template and pick a generation library; ADR-128's deferral is still in effect.

## Alternatives Considered

- **Keep the net-worth chart on the redesigned page**: The concept has no such panel; adding it would require re-introducing the ADR-164 endpoint as an additional client query alongside the overview endpoint — inconsistent with the range-based, single-endpoint composition (ADR-169); dropped from scope.
- **Build getting-paid analytics without a client field (group by transaction name)**: Transaction `name` is free text, inconsistent, and not a reliable counterparty identifier; analysis would be meaningless; rejected.
- **Fetch CPI from INDEC API on the read path**: INDEC's API has reliability and format-change history; fetching live on every report request adds latency and an uncached external dependency; deferred pending a caching and storage decision.

## Consequences

- ADR-164's endpoint survives but has no page consumer in the current build. It is not exposed on any route until a future page is designed around it.
- The three deferred panels are documented with explicit blockers; they cannot be informally re-raised without addressing the stated prerequisite (model change, data source, or library decision).
- Each deferred panel is a candidate for its own `deep-plan` session and ADR cluster when its slice is prioritised.
- Relates to ADR-024/ADR-026 (transaction model — no client/payer field, single date), ADR-128 (PDF export deferred — still applies), ADR-163 (original reports composition — superseded by ADR-167), ADR-164 (net-worth history endpoint — retained, no current page consumer), ADR-165 (CSV export — current contrador workaround), ADR-167 (redesign that triggers these scope decisions), ADR-169 (overview endpoint that covers the panels built in this slice).

## Status History

- 2026-07-02: accepted
