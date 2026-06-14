---
project: margen
adr: 033
title: Frontend transactions API client with a DTO adapter
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-033: Frontend transactions API client with a DTO adapter

## Context

Issue #14 replaces the in-memory mock data source (ADR-015) with the real backend shipped in #3 WITHOUT redesigning screens. Data access must be isolated so the mock can be removed without rewriting components. The backend exposes `GET|POST|PATCH|DELETE /api/v1/transactions` with a `ResponseModel {data}` envelope and camelCase field names matching the mock (ADR-030). CORS is already configured env-driven for the Vite origin (ADR-006/ADR-007), so no dev proxy is needed.

## Decision

Add a real transactions API client that fetches `${VITE_API_BASE_URL}/api/v1/transactions` via direct fetch (no proxy), unwraps the `ResponseModel {data}` envelope, and adapts the backend DTO to the existing frontend `Transaction` shape so components and formatters stay untouched. The TanStack Query hook signatures (`useTransactions` + add/update/delete mutations) stay stable — only their implementation switches from the mock-async module to the real client. `config.ts` (VITE_API_BASE_URL) remains the single base-URL source (ADR-007).

## Alternatives Considered

- **Change frontend types to the backend-native DTO and update components**: Churns the screens; against the issue's explicit "keep components mostly unchanged" acceptance criteria — not chosen.
- **Vite dev proxy for /api**: CORS is already configured (ADR-006); a proxy adds dev/prod config divergence for no benefit — not chosen.

## Consequences

All transaction data access lives behind one client module and the existing query hooks. Screens are untouched. The mock async module is removed for transactions (supersedes the transactions portion of ADR-015). The adapter is the single boundary where contract differences (envelope, type coercion) are resolved — see ADR-034 for the specific field adaptations.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
