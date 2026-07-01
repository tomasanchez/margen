---
project: margen
adr: 137
title: Inflation-reprice model
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-137: Inflation-reprice model

## Context

ADR-125 established a flat nominal per-category monthly budget (spend target vs. actual). The model has no reprice mechanism: a cap set in January is silently mugged by ~2% monthly CPI, so by March the budget describes a price level that no longer exists. Extends ADR-125 (budgets). Reuses ADR-042 (actuals), ADR-044 (suggest/confirm pattern), ADR-118 (CI auto-migrate).

## Decision

Implement inflation-aware repricing as a pure domain function applied only to `kind='spend'` budget rows, on explicit user confirmation at month rollover:

```python
def reprice_cap(cap, monthly_infl, step_up=0):
    return (cap * (1 + monthly_infl / 100)).quantize(CENTS) + step_up
```

- Reprices **spend rows only** (`kind='spend'`); saving rows re-derive automatically from the updated income base as percentages.
- `RepriceMonth` command + handler copies rows from `from_period` → `to_period` with optional per-category `step_ups` (rent/ICL contract index, tariff increases).
- **Confirm-on-rollover, never silent:** the UI detects that the current month has no spend rows while the prior month does, shows a "Reprice for {month}?" preview (old→new per category, fully editable), and the user confirms → one `POST /budgets/reprice`. Nothing mutates without explicit user action.
- Inflation input (MVP): a single manual monthly % seeded from a shipped REM constant (~1.8–2.1%/mo), surfaced as an editable suggestion (suggest/confirm identical to ADR-044). No INDEC scraping in MVP.

## Alternatives Considered

- **Silent auto-reprice on rollover**: automatically applies the stored inflation % and rolls the budget forward — why not chosen: silently mutating a plan erodes trust; the user may have made discrete renegotiations (e.g., a fixed rent contract) that the auto-% would override incorrectly.
- **No reprice (status quo)**: keep flat nominal caps — why not chosen: the core product failure this module exists to fix; by month 3 the budget is describing a past price level.
- **Live INDEC/BCRA feed as the input**: fetch official CPI automatically — why not chosen: deferred to Phase 3 (no clean official JSON API; scraping = ToS/ops fragility; ADR-141).

## Consequences

- Spend budgets remain accurate across months without manual re-entry of every category.
- The user always reviews the reprice diff before it is applied; they can override per-category step-ups (e.g., a frozen rent vs. an ICL-indexed one).
- Saving rows are automatically repriced when the user updates their income base (percentage model); no per-bucket reprice math is needed.
- The pure function is trivially unit-testable (`reprice_cap` unit tests; handler tests against fake repos/UoW); one e2e guard confirms the new month has the correct values.
- MVP does not integrate INDEC; that is the owner's open research question (see ADR-141).
- Relates to ADR-138 (saving rows excluded from reprice), ADR-139 (income base used by saving rows), ADR-141 (macro input source).

## Status History

- 2026-06-30: accepted
