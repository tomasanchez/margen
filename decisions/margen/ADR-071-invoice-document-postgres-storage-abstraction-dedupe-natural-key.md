---
project: margen
adr: 071
title: Store the invoice document in Postgres behind a storage abstraction; dedupe by natural key
category: data
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-071: Store the invoice document in Postgres behind a storage abstraction; dedupe by natural key

## Context

The team decided to keep the original PDF, but no object storage or Azure infrastructure exists yet — only Postgres. Re-uploading the same invoice must be detectable. The extracted text and QR JSON should be retained to enable a future vectorize/search pass without re-parsing.

## Decision

Add an `invoice_document` table (Alembic migration) in a 1:1 relationship with a transaction (FK), storing:

- PDF bytes (`BYTEA`), `content_type`, `byte_size`
- Extracted text (text)
- QR JSON (`JSONB`)
- Invoice natural-key fields: `emisor_cuit`, `pto_vta`, `tipo_cmp`, `nro_cmp`, `cae`
- `fecha`, `importe`, `moneda`, `ctz` for the dedupe check and record

Access the bytes through a small storage abstraction (a port, e.g. `DocumentStore`) whose only adapter today is Postgres. A future Azure Blob adapter becomes a drop-in: store a blob reference instead of bytes without touching callers.

Dedupe: the parse endpoint computes the natural key and flags whether a transaction or document with that key already exists. The UI warns the user but lets them proceed — no hard block (see ADR-068 and ADR-072). Money stays `Decimal` (ADR-025).

## Alternatives Considered

- **Columns on the transactions table**: Bloats the aggregate with a binary blob and import metadata; a 1:1 side table keeps the transaction aggregate lean — not chosen.
- **Object storage now**: No Azure infrastructure exists yet; the storage port enables a swap later without a rewrite — not chosen.
- **Hard-block duplicates**: The user chose warn-and-proceed; a legitimate re-import (corrected amount, re-issued invoice) must remain possible — not chosen.

## Consequences

One side table and one migration; PDFs live in Postgres for MVP (DB growth is accepted at personal-use volumes) behind a port that enables a later Blob migration. The stored text and QR JSON prepare a future pgvector-based semantic search with no re-parse required (deferred, see ADR-073). Dedupe is advisory.

Relates to: ADR-025 (Decimal money), ADR-068 (import flow), ADR-070 (create-with-attachment unit of work), ADR-073 (scope: object storage deferred), ADR-074 (Postgres integration tests for storage + dedupe query).

## Status History

- 2026-06-14: accepted
