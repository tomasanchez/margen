---
project: margen
adr: 034
title: Adapt the contract — UUID string id and Decimal-string money to number
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-034: Adapt the contract — UUID string id and Decimal-string money to number

## Context

The backend (ADR-030) returns `id` as a UUID string; the mock used a numeric id. Money fields (`amountNum`, `usd`, `rate`) are serialized as Decimal strings (e.g. `"45000.00"`) per ADR-025, but the existing frontend `Transaction` type and all components/formatters expect JS numbers. The adapter introduced in ADR-033 is the right place to resolve both mismatches.

## Decision

Change the frontend `Transaction.id` type from `number` to `string` (UUID) and fix every ripple (React keys, `buildEditPrefill`, any code typed as `number` id). In the API-client adapter, parse the Decimal money strings (`amountNum`, `usd`, `rate`) to JS numbers via `parseFloat` so the existing es-AR formatters and components keep working unchanged. ARS magnitudes are well within JS safe-integer range, so display precision is acceptable for the prototype.

## Alternatives Considered

- **Coerce UUIDs to a numeric surrogate id**: Fragile and pointless; the backend issues UUIDs (ADR-026) and the frontend has no need for a numeric key — not chosen.
- **Carry exact Decimals through the UI via decimal.js**: Reworks every formatter and component for no MVP-display benefit; the precision loss from `parseFloat` is negligible for ARS display. Revisit if real client-side money arithmetic is ever needed — not chosen.

## Consequences

`Transaction.id` is a string app-wide from this point. Money arrives as numbers at the adapter boundary; the rest of the app (formatters, components, hooks) is unchanged. If precise client-side arithmetic is needed later, the adapter is the single place to introduce a Decimal library. See ADR-033 for the overall adapter structure and ADR-025/ADR-026 for the backend-side rationale for these types.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
