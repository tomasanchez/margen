---
project: margen
adr: 173
title: Cash-flow forecast is schedule/commitment-driven; amends ADR-129
category: architecture
date: 2026-07-02
status: accepted
supersedes: ADR-129
authors: [Tomas Sanchez]
---

# ADR-173: Cash-flow forecast is schedule/commitment-driven; amends ADR-129

## Context

ADR-129 deferred a recurring-schedule projector in favour of a coarse trailing-average/pace estimate, arguing that the ledger did not yet model scheduling data. That model is now being added (ADR-174: nullable `recurring_cadence`, `installments_total`, `installments_index` on the transaction). With known commitments capturable — subscriptions, periodic taxes, installment tails — projecting from those commitments is both feasible and more accurate than a pace average for the owner's actual spending patterns.

The owner's specific need is to see how committed expenses (subscriptions, AFIP monotributo cuota, credit-card installments) pro-rate across future months. A trailing average cannot express this structure: a 12-month installment tail, a quarterly insurance payment, and a monthly subscription all show up as lumps in the average rather than their true future shape.

## Decision

The cash-flow forecast is **primarily driven by KNOWN COMMITMENTS** projected forward from the transaction ledger. The engine projects each stream with a known cadence (`recurring_cadence`) or installment tail (`installments_total` / `installments_index`) into future months at its latest captured amount.

A trailing-average discretionary band (the approach from ADR-129) is **explicitly deferred** as an optional later enhancement once the committed layer is live and validated. v1 is committed-only.

This supersedes ADR-129's decision to reuse the monotributo trailing-12 projector as the primary mechanism for general cash-flow forecasting. The monotributo forward projection is handled separately (ADR-177).

## Alternatives Considered

- **Retain ADR-129 pace/average approach**: Returns a smooth but structurally wrong line — it cannot express installment tails or subscription spikes; rejected now that the data model supports commitments.
- **Hybrid committed + discretionary in v1**: Adds complexity before the committed layer is validated; deferred — add the discretionary band once committed projections are stable.
- **Require a separate "plan" entity rather than tagging transactions**: Higher accuracy for future scheduling but heavy to build and backfill; superseded by the lean transaction-level approach (ADR-174).

## Consequences

- ADR-129 is superseded. Its pace-average logic is not used for the general forecast in v1.
- The forecast is only as complete as the user's commitment tagging; untagged discretionary spend will not appear in v1 projections (an explicit caveat in the UI).
- When a discretionary band is added later, it must not double-count streams already covered by committed projections (the no-double-count rule in ADR-176 covers this per stream).
- The monotributo trailing-12 reader (ADR-170) is unaffected — it remains the mechanism for the ceiling-proximity panel on Reports.
- Relates to ADR-129 (superseded pace-average approach), ADR-174 (transaction-level commitment metadata), ADR-175 (statement import recovers cuota), ADR-176 (forecast engine contract), ADR-177 (monotributo cuota as committed outflow).

## Status History

- 2026-07-02: accepted
