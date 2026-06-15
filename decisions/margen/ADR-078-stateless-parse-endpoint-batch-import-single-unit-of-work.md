---
project: margen
adr: 078
title: Stateless Parse Endpoint + Batch Import-with-Attachment in One Unit of Work
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-078: Stateless Parse Endpoint + Batch Import-with-Attachment in One Unit of Work

## Context

The ARCA invoice flow separates parsing from persistence across two endpoints (ADR-070): a stateless parse step returns a prefilled draft, and a separate create step persists the transaction with the attached document. The CC statement flow needs the same separation to support confirm-before-save (ADR-075), but must handle N transactions in a single atomic operation rather than one. Persisting each line separately risks partial success — some transactions saved, others not — leaving the statement_document orphaned or the expense set incomplete.

## Decision

`POST /statements/parse` is fully stateless: accepts a multipart PDF, runs the bank parser registry (ADR-076), and returns the detected bank identity, the list of editable line drafts, the document payload (base64-encoded PDF bytes + all statement metadata), and an advisory duplicate flag. Nothing is persisted. `POST /statements/import` accepts the document payload returned by parse plus the user-confirmed list of included line items and, within a single unit of work (ADR-028), saves the `statement_document` once and then bulk-creates every selected line as a `transaction` linked to that document, committing atomically. `GET /statements/{statement_document_id}/document` streams the stored PDF for download. The import response returns the count of created transactions, their IDs, and the `statement_document_id`.

## Alternatives Considered

- **Client loops `POST /transactions` per line**: Non-atomic — partial failures leave orphaned or incomplete state; no shared document row; rejected.
- **Auto-persist at parse time**: Breaks confirm-before-save (ADR-075) and contaminates the database with unconfirmed data on every upload; rejected.

## Consequences

- The stateless parse step can be retried freely — no side effects until import is explicitly called.
- Atomic batch import means either all confirmed lines and the document are saved, or none are — no partial state.
- The document payload round-trips through the client (base64 PDF + metadata); clients must handle potentially large payloads between parse and import calls. This is acceptable for the personal-use scale of the MVP.
- Relates to ADR-070 (invoice parse/create split pattern), ADR-028 (unit of work), ADR-030 (ResponseModel envelope), ADR-075 (confirm-before-save scope), ADR-077 (statement_document table and FK).

## Status History

- 2026-06-14: accepted
