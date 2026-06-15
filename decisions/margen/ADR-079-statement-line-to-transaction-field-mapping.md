---
project: margen
adr: 079
title: Statement Line to Transaction Field Mapping
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-079: Statement Line to Transaction Field Mapping

## Context

A precise, unambiguous mapping from a parsed CC statement line to a `Transaction` record is required so the parser, the import endpoint, and the review UI all share a single source of truth. Edge cases — installments, fee/waiver pairs, payment lines, prior-balance carryover, and USD-denominated purchases — must each have a defined disposition to avoid double-counting or data loss.

## Decision

Each included statement line maps to a `Transaction` as follows:

| Statement field | Transaction field | Notes |
|---|---|---|
| Line PESOS amount | `amount` | Decimal, positive (ADR-025) |
| Line date | `occurred_on` | **Superseded by ADR-089**: now the statement pay/due date; the purchase date is preserved in `notes` and used for reconciliation matching |
| Merchant / reference text | `name` | As printed on statement |
| Issuer + network + last4 | `payment_method` | e.g. "Galicia VISA ·5771" |
| Keyword→category guess | `category` | Default Other/null; editable in review UI |
| Installment marker | `notes` | e.g. "Cuota 3/3"; absent if not an installment |
| — | `kind` | Always `expense` |
| — | `counts_toward_monotributo` | Always `false` (expense; ADR-027, ADR-031) |

**Installments**: Only the amount billed in this statement period is recorded (as-billed slice). No projection of future cuotas — that requires cross-statement state and is out of scope.

**Fees and waivers**: Import genuine fees and interest (e.g. `COM MANT`). Net fee+waiver pairs (e.g. `COM MANT` + `BONI MANT`) to zero — a fully-waived fee produces no transaction. Partial waivers produce one transaction for the net non-zero amount.

**Skip rows**: Payment lines (`SU PAGO`) and carryover balance (`SALDO ANTERIOR`) are always skipped — recording them would double-count.

**USD lines**: Lines in the DÓLARES column map to `currency=USD` with the FX block (ADR-044/045): `usd_amount` is set from the statement's stated dollar amount, `fx_rate` from the statement's stated `cotización` when available (`fx_rate_type='official'`); if not stated, `fx_rate` is left null for manual confirmation in the review UI.

## Alternatives Considered

- **Reconstruct full installment purchase amount**: Requires reading prior and future statements to sum all cuotas — needs cross-statement state not available at import time; rejected.
- **Import payment and carryover lines**: Directly causes double-counting (the payment already matches previously recorded expenses); rejected.

## Consequences

- The mapping is deterministic and fully testable with pure-Python unit tests against fixture text (ADR-082).
- The as-billed installment approach means each month's statement captures only that month's charge slice — consistent with how the card actually impacts the user's cash position.
- Fee-netting requires the parser to see adjacent lines together before emitting transactions; the parser must process the full line list before returning results.
- USD lines with no stated `cotización` leave `fx_rate` null, surfacing the confirmation step in the UI rather than silently guessing.
- Relates to ADR-024 (transaction field definitions), ADR-025 (Decimal), ADR-027 (kind), ADR-031 (lenient validation), ADR-044/ADR-045 (FX block and USD confirm flow).

## Status History

- 2026-06-14: accepted
