---
project: margen
adr: 087
title: Reconciliation Test Strategy
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-087: Reconciliation Test Strategy

## Context

The per-line reconciliation feature (ADR-084, ADR-085, ADR-086) introduces a pure matching heuristic, new import resolution paths (merge, keep_both, import), and new UI elements in the review table. ADR-082 established the all-tiers test strategy for statement import; this ADR mirrors that structure and extends it for the reconciliation paths.

## Decision

### Unit tests (pure, no I/O)

Cover the matcher function in isolation with plain objects:

- Exact-amount match and amount mismatch.
- Date within window (boundary values at ±N days) and date outside window.
- Fuzzy-name similar pairs (e.g., "Sushi dinner" / "SUSHI RECOLETA") and dissimilar pairs.
- Greedy 1:1 assignment — confirm a candidate claimed by the nearest-date line is not also matched to a second line.
- Manual-only candidate filtering — confirm that transactions with a `statement_document_id` are never returned as candidates.

### E2e tests (real in-memory container, no network)

- Parse attaches a `candidate_match` when a seeded manual expense satisfies all three heuristic conditions.
- Parse attaches no match when the seeded expense falls outside the date window, amount differs, or name similarity is below threshold.
- Import with `resolution=merge` enriches the existing transaction (statement document linked, payment method set, category filled if empty, notes set to cuota marker if empty) and creates no duplicate transaction.
- Import with `resolution=keep_both` creates a new transaction and leaves the existing transaction untouched.
- Mixed batch (some `merge`, some `keep_both`, some `import`) commits atomically; failure of any single line rolls back the entire batch.
- Atomicity: injecting a failure mid-batch leaves the database unchanged.

### Integration tests (`@pytest.mark.integration`, real Postgres)

- Merge/enrich path end to end: existing row is updated, statement document is linked, no duplicate row exists.
- Candidate query returns only manual expenses within the date window and excludes already-imported rows.

### Frontend tests

- Flagged row renders a "Possible duplicate" chip and the matched transaction's name · date · amount.
- Per-row resolution control switches between Merge and Keep both; the submitted payload carries the correct `resolution` and `match_transaction_id`.
- Import summary reads "N new / M merged" reflecting the chosen resolutions.

### Offline gate

Unit tests and e2e tests remain at 100 % pass rate before any PR merges. Integration tests run in CI with a real Postgres container (ADR-032/050).

## Alternatives Considered

- **Unit-test the matcher through the HTTP layer only**: Obscures the pure function behind I/O and makes boundary-value testing slow — rejected; the matcher is tested as a plain function.
- **Skip e2e merge/enrich path, rely on integration only**: Integration tests need a running Postgres; e2e with an in-memory container is faster and catches the same logic errors earlier — both tiers are included.

## Consequences

- The pure matcher must be structured as an importable function (not inlined in the handler) so unit tests can call it directly.
- Test fixtures for e2e must seed manual expenses with controlled dates, amounts, and names to exercise boundary conditions.
- Relates to ADR-082/074 (all-tiers test strategy for statement and invoice import), ADR-032/050 (tier definitions and CI integration), ADR-084/085 (reconciliation logic under test).

## Status History

- 2026-06-14: accepted
