---
project: margen
adr: 181
title: Outstanding installment liability derived from per-transaction cuota fields, not a plan aggregate
category: data
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-181: Outstanding installment liability derived from per-transaction cuota fields, not a plan aggregate

## Context

ADR-180 introduces a `liabilities.installments` field on the net-worth read model. ADR-174 added `recurring_cadence`, `installments_total`, and `installments_index` to the transaction table to support the forecast engine. The question is how to derive the outstanding installment balance: from a first-class `InstallmentPlan` entity (full lifecycle object) or directly from the per-transaction fields already present.

A first-class plan entity would model early payoff, refinance, and variable per-installment amounts, but none of those features have demonstrated owner need. ADR-174 already deferred that entity behind YAGNI reasoning.

## Decision

The outstanding installment liability is computed as:

```
liability = Σ (remaining_count × cuota_amount)
          for each active installment stream
```

where:
- `remaining_count = installments_total − installments_index` measured from the **latest posted cuota** of each stream (grouped by stream identity: same name/category/amount series).
- `cuota_amount` = the `amount` of the latest posted cuota for that stream (ARS or USD per its denomination).
- "Active" stream = has `recurring_cadence='installment'` and `installments_index < installments_total` on its latest posted row.

This covers the **full remaining tail** (every future cuota), consistent with the forecast engine's stream logic (ADR-176) and extends ADR-174.

**No-double-count property:** `remaining = total − index` is measured from the latest posted cuota. Paid cuotas (index ≤ latest posted index) are excluded by construction — there is no risk of counting a cuota both as an Expense (already in `total`) and as a remaining liability.

**No first-class `InstallmentPlan` entity** is introduced. If lifecycle features (early payoff, refinance, variable cuota amounts) are later demonstrated as needed, the plan entity is the migration target; the nullable columns become a bridge (as stated in ADR-174).

## Alternatives Considered

- **First-class `InstallmentPlan` aggregate**: Models the full lifecycle with its own CRUD, status, and payoff date — correct for complex financial products but unjustified at current scale; deferred per ADR-174's YAGNI ruling; rejected here for the same reason.
- **Derive from statement import metadata only (ADR-175 parsed Cuota N/M notes)**: Statement import populates `installments_total/index` via ADR-175; relying on notes alone (pre-ADR-175 rows) would miss manually-entered installment transactions; the structured columns are authoritative.
- **Snapshot liability at import time into a separate column**: Adds a write path and staleness concern when cuotas are edited; the derivation at read time from existing columns is simpler and always current.

## Consequences

- No new table, no new columns beyond ADR-174's three nullable fields.
- The net-worth read model queries `recurring_cadence='installment'` rows, groups by stream identity, and aggregates `remaining_count × cuota_amount` per stream.
- Accuracy depends on transaction tagging: streams tagged via ADR-174/ADR-175 are included automatically; untagged installment purchases are not.
- The derivation reuses the forecast engine's stream-grouping logic (ADR-176); the two should share a service-layer function to stay consistent.
- Relates to ADR-024 (transaction model), ADR-089 (CC due-date dating — installment cuotas are dated on pay date, so `occurred_on` aligns with the liability period), ADR-174 (source fields for the derivation), ADR-175 (statement import populates those fields), ADR-176 (shared stream logic), ADR-180 (consumer of `liabilities.installments`), ADR-182 (membership rule — installments are the only Slice-1 liability type), ADR-183 (FX conversion of ARS/USD cuota amounts).

## Status History

- 2026-07-03: accepted
