---
project: margen
adr: 166
title: Recharts as the frontend charting library for Reports
category: ux
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-166: Recharts as the frontend charting library for Reports

## Context

ADR-128 defines the Reports page but does not mandate a chart library. Until now Margen's frontend has had no charting dependency — all data has been presented in tables and summary cards. The Reports page introduces two time-series visualisations:

1. A **spending-trend line/bar chart** (6-month expenses, derived from the summaries reader — ADR-042).
2. A **net-worth-over-time line chart** (monthly balance history — ADR-164).

The category breakdown and budget-vs-actual panels remain tabular and will use MUI components (already a project dependency). A chart library is required only for the two time-series views.

The existing frontend stack is React + Vite + MUI + Tanstack Query (ADR-005). Adding a charting library introduces a new production bundle dependency; the choice must balance capability, bundle cost, and maintenance burden.

## Decision

Add **Recharts** (`recharts`) as a new `apps/web` production dependency for the spending-trend and net-worth-over-time charts.

- Charts are rendered as `<LineChart>` / `<BarChart>` Recharts composables inside the Reports page components.
- MUI `<Table>` / `<DataGrid>` continue to render the category breakdown and budget-vs-actual panels — no Recharts involvement.
- Recharts is a frontend-only dependency: no backend changes, no new API, no test coverage gate impact (ADR-032 applies only to the backend 100% coverage rule).

## Alternatives Considered

- **Victory**: Comparable API surface, React-native, actively maintained — a reasonable alternative. Slightly larger bundle than Recharts for equivalent chart types; less community prevalence in the React + MUI ecosystem; not chosen, but not ruled out for future chart types.
- **Chart.js (via react-chartjs-2)**: Mature, large community, canvas-based — imperative API requires more adapter code in a declarative React component tree; canvas rendering is less accessible than SVG; not chosen.
- **D3 directly**: Maximum flexibility, no opinionated wrapper — requires significant boilerplate for common chart types; far higher implementation cost for two straightforward time-series views; rejected for MVP scope.
- **No chart library (table-only)**: Defers charts entirely — eliminates the dependency cost but removes a core "replace your Excel" value proposition (ADR-120); rejected.

## Consequences

- New `pnpm` production dependency in `apps/web`; bundle size increases by approximately 200–300 KB gzipped for the Recharts treeshake (acceptable for a PFM app, not a performance-critical public page).
- Recharts is SVG-based: accessible, themeable, and consistent with MUI's rendering approach.
- Chart components are isolated to the Reports feature directory; Recharts is not used elsewhere unless a future decision extends it.
- If a richer chart type is needed later (e.g., stacked area, scatter), Recharts supports it without adding another library.
- Relates to ADR-005 (frontend stack), ADR-128 (reports scope), ADR-163 (reports page composition), ADR-164 (net-worth history data driving the line chart).

## Status History

- 2026-07-02: accepted
