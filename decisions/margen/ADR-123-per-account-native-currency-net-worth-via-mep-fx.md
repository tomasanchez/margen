---
project: margen
adr: 123
title: Per-account native currency; net worth aggregated via MEP FX
category: data
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-123: Per-account native currency; net worth aggregated via MEP FX

## Context

Money is stored ARS-authoritative (ADR-025) with a USD display transform (ADR-056). Argentine users routinely hold USD cash or USD bank accounts (e.g., Deel payouts). Treating a USD account balance as ARS would misstate real holdings and drift arbitrarily with the exchange rate.

## Decision

Each account carries a `currency` field (ARS or USD). A USD account stores and reports balances in USD natively. Net worth aggregation converts across currencies using the MEP rate (ADR-044) and presents the total in the user's display currency (ADR-056).

This amends ADR-025: account-level balances are no longer strictly ARS-authoritative. The ARS-authoritative invariant is retained for transactions denominated in ARS; USD accounts are USD-authoritative.

## Alternatives Considered

- **Keep ARS-authoritative + display conversion only**: USD account balances would be stored in ARS and drift with every rate change, misstating real holdings — rejected.

## Consequences

- Mixed-currency aggregation in the net-worth reader; FX rate is required at display time.
- Net worth carries FX drift between rate updates (known limitation, recorded in ADR-132).
- Amends the ARS-authoritative invariant (ADR-025) for account-level balances.
- FX infrastructure (ADR-044, ADR-056) is reused without new external dependencies.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
