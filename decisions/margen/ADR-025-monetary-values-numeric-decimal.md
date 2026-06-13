---
project: margen
adr: 025
title: Store monetary values as NUMERIC/Decimal
category: data
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-025: Store monetary values as NUMERIC/Decimal

## Context

Transactions carry an ARS-equivalent amount plus optional original USD amount and FX rate. Money must be exact — floating-point drift is unacceptable for financial figures. The backend uses asyncpg (ADR-004), which has native NUMERIC support.

## Decision

Store money as Postgres `NUMERIC` mapped to Python `Decimal` (asyncpg native):

- `amount` (ARS-equivalent magnitude): `NUMERIC(18,2)`
- `usd_amount`: `NUMERIC(18,2)` (nullable)
- `fx_rate`: `NUMERIC(18,6)` (nullable)

The ARS-equivalent `amount` is authoritative and always positive — sign derives from `kind`/`type`. When converting from USD: `amount = round(usd_amount × fx_rate, 2)`.

## Alternatives Considered

- **Integer minor units (cents as BIGINT)**: Avoids decimal ambiguity but forces ×100 scaling on every boundary and diverges from the frontend's plain-number mock — not chosen.
- **Float/double**: Float drift is unacceptable for money — not chosen.

## Consequences

Exact arithmetic throughout the domain. `Decimal` flows from the DB through the domain to the Pydantic boundary models, which serialize it to JSON numbers. The explicit rounding rule for USD rows prevents implicit precision surprises. Relates to ADR-026 (date/id) and ADR-029 (FX metadata block) which share the same column conventions.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
