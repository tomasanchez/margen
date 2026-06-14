---
project: margen
adr: 038
title: Test by mocking the HTTP client; add adapter and error-state tests
category: testing
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-038: Test by mocking the HTTP client; add adapter and error-state tests

## Context

The existing interaction tests mock the in-memory mock-async API (ADR-015, ADR-018), which is being removed for transactions. Fast tests must not require a running backend. Three new concerns need explicit test coverage: the DTO adapter logic, error-state rendering, and the HTTP-layer interaction.

## Decision

Rewrite the interaction tests to mock the HTTP client (or global `fetch`) returning the `ResponseModel {data}` envelope shape (ADR-030), so no real backend is required. Add:

1. A **unit test for the adapter** asserting Decimal-string-to-number parsing, `{data}` envelope unwrap, and UUID string `id` (covering ADR-034).
2. An **error-state test** asserting that a query error renders the calm unavailable panel and that the Retry button calls `refetch` (covering ADR-037).

`npm test`, `npm run lint`, and `npm run build` must remain green. Live end-to-end correctness is verified manually against the running API.

## Alternatives Considered

- **Playwright e2e against a live backend**: Heavy infrastructure for a data-source swap; fast mocked tests give the same contract confidence. DB-backed e2e can be introduced as a follow-on — not chosen.

## Consequences

Fast, offline, deterministic tests that assert the contract adaptation and error behavior. The adapter boundary (ADR-033) is fully covered by unit tests. Real integration is proven by manual end-to-end runs and the backend's own integration tests (ADR-032). The test pattern for mocked HTTP is reusable when #6/#8 go real.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
