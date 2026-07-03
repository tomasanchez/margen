---
project: margen
adr: 180
title: Net worth gains a layered liabilities reservation; total stays assets-only
category: architecture
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-180: Net worth gains a layered liabilities reservation; total stays assets-only

## Context

ADR-122 defined net worth as the sum of account balances (assets). ADR-164 built a net-worth history on that definition. The owner now wants to see how locked-in obligations (installment tails; later CC balances and other debts) reduce their effective financial position, without losing the clean "sum of balances" baseline that makes the history coherent.

Redefining `total` to mean "assets minus liabilities" would break ADR-164's history chart — historical totals were computed as assets-only, so a redefinition would make the time series discontinuous.

## Decision

Add a **layered liabilities reservation** to the net-worth read model, **alongside** the existing `total` field:

| Field | Definition | Governed by |
|-------|-----------|-------------|
| `total` | Sum of account balances (assets). Unchanged. | ADR-122 |
| `liabilities` | Typed breakdown of locked-in obligations. | This ADR |
| `net_after_liabilities` | `total − liabilities.sum`. Derived. | This ADR |

`liabilities` is a **typed breakdown** (not a scalar) so future obligation types are additive:

```json
{
  "installments": 0.00,
  "cc_balance": null,
  "other": null,
  "sum": 0.00
}
```

`installments` is the only populated field in Slice 1 (ADR-181). `cc_balance` and `other` are null now — typed placeholders, not a reshape; adding them later does not change the response shape.

**UI surface:** The net-worth card/view displays "Net worth" (the `total` assets figure, unchanged) with a secondary "Net of commitments" line showing `net_after_liabilities`. The two are visually distinct; `total` remains the headline number.

**Reversible and additive**: removing the accent reverts to showing `total` only. No existing history or query is changed.

### Deferred to later slices (own ADRs when built)

- **Credit-card unpaid-balance liability**: The unpaid CC balance at month-end is the natural next liability type. ADR-089 already dates imported CC lines on the due date, so the pending→paid flip is largely handled at the transaction level; the outstanding balance aggregation is the remaining work.
- **Due-date timing precision**: When a CC liability is added, the pending→paid transition for that stream follows ADR-089's pay-date convention.
- **"Other debts" aggregate**: A catch-all for personal loans or informal debts not modeled as installment streams.

## Alternatives Considered

- **Redefine `total` as assets − liabilities**: Breaks the ADR-164 history chart (discontinuous series); rejected.
- **New separate "liabilities" card/page**: Promotes obligations to a top-level view before validated need; adds nav complexity (ADR-127/ADR-172); deferred — an accent on the existing net-worth view is sufficient in Slice 1.
- **Single scalar `liabilities` field**: Loses the breakdown needed to add CC balance and other debts later without reshaping the response; rejected in favour of a typed object.

## Consequences

- `total` and ADR-164 history are untouched; the history chart remains coherent.
- The net-worth endpoint gains two new response fields (`liabilities`, `net_after_liabilities`); clients that ignore them are unaffected.
- The `liabilities` typed object is the extension point: `cc_balance` and `other` populate in future slices without breaking existing consumers.
- ADR-122's "sum of balances" semantics are formally preserved; `net_after_liabilities` is a derived view, not a redefinition.
- Relates to ADR-089 (CC due-date dating — relevant when CC liability is added), ADR-122 (assets definition — preserved), ADR-123 (MEP FX rate used for net-worth display — liabilities use the same rate per ADR-183), ADR-164 (net-worth history — unaffected), ADR-181 (installment liability derivation — populates `liabilities.installments`), ADR-182 (membership rule — what enters `liabilities`), ADR-183 (FX conversion of liability amounts).

## Status History

- 2026-07-03: accepted
