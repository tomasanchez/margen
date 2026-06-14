---
project: margen
adr: 031
title: Lenient validation and edge-case handling
category: risks
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-031: Lenient validation and edge-case handling

## Context

Issue #3 surfaces edge cases from the prototype: USD without a rate, refunds/money-back entries, backdated transactions, missing category, invoice-without-payment, income-without-invoice, and very large amounts. The prototype favors fast entry over strict gate-keeping. Relates to ADR-020 (prototype open items) and ADR-027 (kind/type invariants).

## Decision

Validate with domain invariants but stay lenient:

- `amount` (ARS-equivalent) is **always required and positive**; sign derives from `kind`/`type` — never store negative amounts.
- **USD without rate**: a USD row `SHOULD` carry `usd_amount` + `fx_rate`, but USD-without-rate is **accepted as incomplete** (`amount` stands as the authoritative ARS equivalent) rather than blocking entry.
- **Refunds / money-back**: modeled as `kind = income` — never negative magnitudes; sign comes from type.
- **Backdated `occurred_on`**: allowed without restriction.
- **Missing category**: allowed (nullable or `'Other'`).
- **`countsTowardMonotributo`**: only meaningful for `income`/`invoice`; forced `false` for `expense` (invariant, not a validation error).
- **Very large amounts**: `NUMERIC(18,2)` accommodates them (ADR-025).

## Alternatives Considered

- **Strict validation (reject USD-without-rate, require category)**: Blocks the fast-entry cases the prototype intentionally supports — not chosen.

## Consequences

Entry is never blocked on incomplete FX metadata or missing category; the data store may contain incomplete-but-valid rows that #6 (categories) and #7 (FX display) can enrich later. Core invariants still prevent contradictory `kind`/`type` states and negative magnitudes. See ADR-029 for how the FX block accommodates the null-rate case. Note: ADR-044 revisits the UI side — the frontend now requires a rate before saving a USD transaction; this backend leniency remains unchanged.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
