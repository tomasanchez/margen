---
project: margen
adr: 070
title: Stateless parse endpoint + create-with-attachment (separate from persistence)
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-070: Stateless parse endpoint + create-with-attachment (separate from persistence)

## Context

The confirm-before-save UX (ADR-068) needs the extracted fields before anything is persisted. Coupling parse to create would complicate the review step, error handling, and re-tries.

## Decision

Add `POST /api/v1/invoices/parse` — a multipart upload endpoint that runs the parser (ADR-069) and returns the extracted fields, parse status, computed natural key, and a duplicate flag under the ResponseModel envelope (ADR-030), camelCase, with NO persistence. The frontend prefills the Add/Edit form from this response; the user confirms; the existing transaction create path then persists the transaction.

The transaction create command/handler is extended to optionally accept the uploaded document so it is stored and linked (ADR-071) as part of the same unit of work. File constraints (PDF-only, size cap) are enforced at the endpoint layer (ADR-073).

## Alternatives Considered

- **Single upload-and-create endpoint**: Couples parsing to persistence; complicates confirm-before-save and re-parse on validation error — not chosen.
- **Persist a pending import server-side between parse and confirm**: Adds server-side state and a cleanup job; a stateless parse response held by the client as a draft is simpler for MVP — not chosen.

## Consequences

A clean parse / confirm / create flow. The parse endpoint is stateless and idempotent — safe to retry. The create path gains an optional file attachment without changing its contract for callers that do not use import. Two HTTP calls (parse, then create) — acceptable for a single-file manual upload.

Relates to: ADR-068 (confirm-before-save requirement), ADR-069 (parser), ADR-030 (ResponseModel envelope), ADR-071 (document storage wired into create), ADR-073 (file constraints), ADR-074 (test strategy).

## Status History

- 2026-06-14: accepted
