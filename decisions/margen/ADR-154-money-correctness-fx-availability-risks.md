---
project: margen
adr: 154
title: Money-correctness and FX-availability risks for the FX-snapshot model
category: risks
date: 2026-06-30
status: proposed
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-154: Money-correctness and FX-availability risks for the FX-snapshot model

## Context

The FX snapshot model (ADR-148 through ADR-153) introduces new external dependencies (historical FX sources for backfill, ADR-150) and new data paths (client-supplied rates materialized to `usd_amount`, USD budget spend via `SUM(usd_amount)`). These decisions inherit a class of money-correctness and availability risks that should be captured explicitly rather than assumed solved.

## Decision

The following risks are accepted as known and mitigated as described. They are tracked here for implementation and future review.

**Risk 1 — Historical FX source availability and accuracy (HIGH)**
The client-driven backfill (ADR-150) depends on a historical MEP rate source (candidate: ArgentinaDatos `api.argentinadatos.com/v1/cotizaciones/dolares/mep`). If the source is unavailable, inaccurate, or has coverage gaps for certain dates, backfill will be incomplete or will use wrong rates.
Mitigation: VERIFY the source's date coverage and rate accuracy against known reference rates before relying on it in production; expose a manual override in the backfill UI so the user can correct any incorrect rate; the `fx_source = 'backfill'` tag makes machine-filled rates distinguishable from interactively confirmed ones.

**Risk 2 — Transactions transiently lacking a snapshot → incomplete USD spend (MEDIUM)**
Statement imports and pre-backfill rows carry null `usd_amount`. Until rate-fill completes, USD budget spend totals are understated.
Mitigation: the unconverted-note rule (ADR-152) surfaces the count of unsnapshotted transactions as a visible note rather than silently excluding them. The backfill step (ADR-150) is idempotent and can be re-run at any time.

**Risk 3 — Round-trip fidelity for USD-native rows (LOW)**
For transactions where the user spent a round USD amount, reconstructing the USD figure as `round(amount ÷ fx_rate, 2)` may introduce a rounding error of ±0.01 USD relative to the original USD spend.
Mitigation: the `usd_amount` is stored as a materialized snapshot at capture time (ADR-148); it does not need to be recomputed from `amount` after storage. The server recomputes only at write time (ADR-149), after which the stored value is stable. Precision is `NUMERIC(18,2)` per ADR-025, which is sufficient for individual transaction amounts.

**Risk 4 — Rate-source drift between capture time and display time (LOW)**
A USD budget viewed months after transactions were captured may display a rate in the summary header (live MEP for context) that differs from the per-row capture rates. This can create apparent inconsistencies if the user compares the displayed rate to their summed USD spend.
Mitigation: the UI should clarify that spend figures reflect capture-time rates (stored `usd_amount`), not a re-conversion at the current rate. The `fx_source` per row is queryable; a detailed transaction view can surface the individual capture rate.

## Alternatives Considered

- **Treat all risks as implementation details (no ADR)**: Risk 1 (historical source unverified) and Risk 2 (unconverted-note contract) are cross-cutting concerns referenced from multiple ADRs; capturing them centrally avoids each implementer re-deriving the same analysis; rejected for ADR omission.

## Consequences

- Risk 1 requires explicit verification of ArgentinaDatos (or dolarapi historical) before the backfill feature ships. A failing verification should trigger a fallback to a different source or a manual-only backfill mode.
- Risk 2 is structurally mitigated by the unconverted-note rule in ADR-152; no additional schema change is needed.
- Risk 3 is structurally mitigated by the immutable stored snapshot; no additional action required.
- Risk 4 requires UI copy clarification; no backend or data-model change needed.
- Relates to ADR-148 (snapshot model), ADR-149 (client-side capture), ADR-150 (backfill + historical source), ADR-151 (preferred rate source), ADR-152 (unconverted-note rule), ADR-153 (USD income suggestion sparse path).

## Status History

- 2026-06-30: proposed
