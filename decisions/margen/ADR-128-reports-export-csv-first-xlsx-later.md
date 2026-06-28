---
project: margen
adr: 128
title: Reports and export: CSV first, .xlsx later
category: business
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-128: Reports and export: CSV first, .xlsx later

## Context

"Replace your Excel" implies the user can leave the spreadsheet with their own data and see basic reports inside Margen. Export and reporting are core to this value proposition. The project maintains a 100% coverage gate (ADR-019), and adding a formatted spreadsheet library (openpyxl) introduces a new backend dependency that requires test coverage.

## Decision

MVP export is CSV (transactions export + summary export) — no new backend library required; Python's standard `csv` module suffices.

Reports included in MVP: month-over-month comparison, category breakdown, and net-worth-over-time — reusing existing category summary (ADR-042) and account balance readers.

Real formatted .xlsx export (openpyxl, multi-sheet, styled) is deferred as a later enhancement.

## Alternatives Considered

- **xlsx now**: Adds openpyxl as a new backend dependency; every new code path must reach 100% coverage, increasing test cost for a formatting-only feature — rejected for MVP.

## Consequences

- CSV export endpoint(s) added to the API.
- A Reports page added to the frontend with chart/table views of the above reports.
- xlsx is a clear, logged next enhancement that does not require schema or API changes.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
