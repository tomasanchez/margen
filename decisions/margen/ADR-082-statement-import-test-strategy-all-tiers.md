---
project: margen
adr: 082
title: Statement Import Test Strategy (All Tiers)
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-082: Statement Import Test Strategy (All Tiers)

## Context

The CC statement import feature spans a native-lib parser, a registry, category heuristics, fee-netting logic, multiple endpoint behaviours, atomic batch persistence, and document download. Each concern must be covered at the right tier to keep the gate fast and the integration tests meaningful — mirroring the strategy established for ARCA invoice import in ADR-074 and the broader test tiers in ADR-032 and ADR-050.

## Decision

**Unit tests (gate-eligible, included in `make cover` at 100%)**

Cover all pure-Python logic with the native PyMuPDF boundary monkeypatched:

- Galicia VISA parser: line extraction from a sanitized plain-text fixture, fingerprint/detection checks, category guesser keyword mapping.
- Fee-netting logic: COM MANT + BONI MANT pairs netting to zero, partial waiver producing a net transaction.
- Payment and carryover skipping: `SU PAGO` and `SALDO ANTERIOR` rows produce no output.
- Installment note formatting: "Cuota 3/3" appears in `notes`; amount is the as-billed slice only.
- USD line mapping: `currency=USD`, `usd_amount`, `fx_rate` from stated `cotización`; null `fx_rate` when not stated.

**E2e / endpoint tests (gate-eligible, `FakeUnitOfWork` + `FakeStatementStore`, parser monkeypatched to canned output)**

- `POST /statements/parse`: HTTP 415 for non-PDF, HTTP 413 for oversized file, HTTP 422 for malformed multipart; success returns bank identity + line drafts + document payload + duplicate flag.
- Unsupported bank: parse returns calm unsupported status, not an exception.
- Duplicate advisory: parse flags an existing natural key; import is not blocked.
- `POST /statements/import`: atomic batch — all selected lines and the statement_document are created in one commit; returns created count + transaction IDs + statement_document_id.
- `GET /statements/{id}/document`: returns 200 with PDF bytes for a known document; 404 for unknown ID.

**Integration tests (`@pytest.mark.integration`, excluded from the CI gate)**

- Parse a real sanitized Galicia VISA statement PDF fixture using native PyMuPDF; assert extracted lines, bank identity, and metadata match expected values.
- Exercise the real Postgres `statement_document` table: insert a document, run the dedupe natural-key query, confirm the duplicate flag is returned correctly on a second parse call.
- Full import path against a live test database: parse → import → verify transactions linked via `statement_document_id` FK.

A sanitized PDF fixture (scrubbed of real name, address, account numbers) lives under `tests/fixtures/` and is committed to the repository. The CI gate never touches this fixture with native PyMuPDF — only integration tests do.

## Alternatives Considered

- **Only unit tests, no integration tier**: Would leave the native PyMuPDF text extraction and the Postgres dedupe query untested in any realistic scenario; inconsistent with ADR-074 and ADR-032; rejected.
- **Integrate all tiers into the gate**: Native PyMuPDF tests are slow and require a live database; this violates the fast-gate discipline from ADR-032 and ADR-050; rejected.

## Consequences

- The gate remains fast: all gate-eligible tests use monkeypatched native boundaries and in-memory fakes.
- The sanitized fixture commitment is a team norm enforced by ADR-081 (no real PII in fixtures).
- The 100% unit coverage target for the pure parser and mapping logic incentivises keeping the PyMuPDF boundary narrow (ADR-076).
- Integration tests give confidence that the real parser and Postgres schema work end-to-end without burdening the gate.
- Relates to ADR-074 (invoice import test strategy), ADR-032 (test tiers and gate policy), ADR-050 (monotributo test strategy pattern), ADR-076 (narrow PyMuPDF boundary), ADR-081 (sanitized fixture requirement).

## Status History

- 2026-06-14: accepted
