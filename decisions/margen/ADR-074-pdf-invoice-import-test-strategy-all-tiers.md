---
project: margen
adr: 074
title: Test the PDF invoice import across the tiers
category: testing
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-074: Test the PDF invoice import across the tiers

## Context

ADR-032 mandates fully-mocked fast tiers for the 100% `make cover` gate plus a real-Postgres integration tier. ADR-038 establishes that the frontend mocks the HTTP client adapter. The parser (ADR-069) is the highest-risk unit: it handles an external binary format and a native-library dependency (pyzbar / zbar).

## Decision

**Backend — unit tests (parser + mapping)**:

- AFIP QR-URL extraction and base64url JSON decode, using sample QR payloads.
- Field mapping: `importe`/`fecha`/`moneda`/`ctz` -> `amount`/`occurred_on`/USD FX block (ADR-044/045); name from text fallback to invoice number `"Invoice <ptoVta>-<nroCmp>"`; dedupe natural key computation.
- Parse-failure paths: no QR found, non-PDF input, malformed QR JSON.
- Use tiny fixture PDFs and fixture QR payloads. **Mock the PDF render and QR decode boundary** in the fast tier so the gate requires no native `zbar` installation.

**Backend — mocked-reader/handler e2e (fast tier)**:

- `POST /invoices/parse`: 200 + extracted fields + duplicate flag; 415 on non-PDF; 422 on oversized / malformed; calm error body on unparseable.
- Create-with-attachment: transaction created + document record attached.

**Backend — Postgres integration tier**:

- `invoice_document` storage round-trip (write + read bytes, text, QR JSON).
- Dedupe-by-natural-key query: returns the duplicate flag correctly for a known natural key.

Keep `make cover = 100%` and `make lint` green.

**Frontend — Vitest + RTL, mocking the HTTP client adapter (ADR-038)**:

- Upload -> parsed fields prefill the Add/Edit form.
- Confirm -> create transaction call fires with the document.
- Duplicate warning renders when the parse response sets the flag.
- Unparseable PDF -> calm error state renders + "enter manually" fallback is tappable.
- Attachment badge renders on a saved transaction with a linked document.

## Alternatives Considered

- **Rely on the native zbar library in the fast tier**: Would make the 100% cover gate depend on a native dependency not present in the standard CI environment; mock the decode boundary in unit/e2e and verify the real path only in the integration tier — not chosen.

## Consequences

The parser and mapping logic are pinned by fast tests without a native dependency. Document storage and dedupe are proven on real Postgres. The `make cover` and `make lint` gates hold without any environment changes. The frontend confirm-flow and all calm states are covered by mocked-client tests.

Relates to: ADR-032/038 (test tiers and frontend mock client), ADR-069 (parser boundaries to mock), ADR-070 (endpoints under test), ADR-071 (Postgres integration for storage + dedupe), ADR-072 (frontend calm states under test), ADR-037 (calm state conventions).

## Status History

- 2026-06-14: accepted
