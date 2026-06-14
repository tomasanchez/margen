---
project: margen
adr: 47
title: "Monotributo read endpoint GET /api/v1/monotributo mirroring the summaries read-model pattern"
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-047: Monotributo read endpoint GET /api/v1/monotributo mirroring the summaries read-model pattern

## Context

The standing, projection, and invoice drilldown must be computed server-side from persisted transactions. ADR-042 established the cosmic read-side seam for summaries: an abstract reader port, frozen read-model dataclasses, a SQLAlchemy reader implementation, pure business logic, and a CamelCase response schema under the `ResponseModel` envelope (ADR-030). This new endpoint follows the identical pattern for consistency and testability.

ADR-025 governs Decimal/NUMERIC money representation. ADR-046 defines the business rules (trailing-12-month basis, status bands, linear-annualization projection). ADR-048 covers the data persistence and reference constants the reader depends on.

## Decision

Add **`GET /api/v1/monotributo`** (parameterless; trailing-12-month window computed from server "today").

Introduce the following modules mirroring the summaries seam (ADR-042/ADR-043):

- `service_layer/monotributo_reader.py` — `AbstractMonotributoReader` port.
- `service_layer/monotributo_read_models.py` — frozen read-model dataclasses: a snapshot containing `currentCategory`, `activityType`, `limit`, `used`, `remaining`, `percentUsed`, `status`, `projectedCategory`, `projectionNote`, `periodStart`, `periodEnd`, a scale rows list (A–K), and an `invoices[]` drilldown.
- `service_layer/monotributo.py` — pure business logic: status bands, linear-annualization projection, smallest-category-that-fits lookup, margin/percent math, exclusion of non-counting records.
- `adapters/queries.py` (extended) — `SqlAlchemyMonotributoReader` summing `counts_toward_monotributo=true` income over trailing 12 months and selecting the included invoice rows.
- `entrypoint/monotributo_schemas.py` — `CamelCaseModel` response schema with `from_read_model`, Decimal money per ADR-025.
- `dependencies.py` — `get_monotributo_reader` for DI.
- `router.py` — route registration.

Current category and activity type come from persisted config (ADR-048). A–K ceilings come from backend reference constants (ADR-048). The endpoint returns the full snapshot including the scale table.

## Alternatives Considered

- **Compute on the frontend from the transactions list**: pushes financial business rules into the client; server-side keeps logic testable and the contract stable, consistent with the summaries pattern (ADR-042).
- **Extend the summaries endpoint**: different period (trailing-12 vs. calendar month) and different concern; a dedicated endpoint is cleaner and avoids polluting the summaries contract.

## Consequences

A new read endpoint and reader following the proven summaries seam from ADR-042/ADR-043. Pure logic in `service_layer/monotributo.py` is fast-unit-testable (ADR-050). The SQL aggregation gets a Postgres integration test (ADR-032). Frontend (ADR-049) swaps the mock for a real client without a redesign, mirroring the summariesClient/useSummary wiring (ADR-033/ADR-043).

The PATCH for config (ADR-048) lives at the same or an adjacent path and shares DI conventions.

## Status History

- 2026-06-14: accepted
