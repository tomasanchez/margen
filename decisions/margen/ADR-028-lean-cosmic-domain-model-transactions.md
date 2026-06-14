---
project: margen
adr: 028
title: Lean cosmic domain model for transactions
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-028: Lean cosmic domain model for transactions

## Context

`apps/api` follows the domain-first cosmic patterns established by the scaffold (ADR-003): add only the patterns a use case needs, with no ceremony to fill directories. Transaction CRUD is the first real domain object, so the boundary must be right — but it must not front-load complexity the MVP doesn't yet require.

## Decision

Model a `Transaction` aggregate (plain Python domain object) with:

- **Frozen Pydantic commands**: `CreateTransaction`, `UpdateTransaction`, `DeleteTransaction`
- **Application handlers**: one handler per command, tested with fakes
- **Async repository + async Unit of Work**: for writes (SQLAlchemy 2 + asyncpg per ADR-004)
- **Reader port + read model**: for list/get queries (separate from the write model)
- **No domain events / message-bus eventing yet**: added only when a downstream use case (#6, #7, #8) needs it

## Alternatives Considered

- **Thin CRUD service over the repository**: Diverges from the project's domain-first standard and would require refactoring as #6/#7/#8 add logic — not chosen.
- **Full message-bus + domain events now**: Adds ceremony the MVP CRUD does not yet need — not chosen.

## Consequences

Idiomatic, testable boundaries: handlers are unit-tested with fakes; the reader is tested separately from write paths. Domain events and the message bus can be introduced later without restructuring the aggregate. See ADR-032 for the test strategy that depends on these seams. The cosmic pattern follows ADR-003.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
