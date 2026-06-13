---
project: margen
adr: 030
title: Transaction REST API contract
category: architecture
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-030: Transaction REST API contract

## Context

The frontend must eventually (#14) swap its mock (ADR-015) for these endpoints cleanly. The project enforces `ResponseModel[T]` envelopes and camelCase JSON aliases at the boundary. The scope of #3 is minimal — the UI still filters client-side and does not consume server-side filters yet.

## Decision

REST resource at `/transactions`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/transactions` | List all, newest-first by `occurred_on` |
| `POST` | `/transactions` | Create — returns the persisted entity (UUID + timestamps) |
| `GET` | `/transactions/{id}` | Get one |
| `PATCH` | `/transactions/{id}` | Partial update |
| `DELETE` | `/transactions/{id}` | Hard delete |

- Responses use the `ResponseModel[T]` envelope.
- JSON fields use **camelCase aliases** matching the frontend mock field names.
- **Filtering, sorting, and pagination** query params (`type`, `currency`, `category`, `bank`, `date`, `search`) are **documented as the planned extension for #14** but not implemented now.
- The contract is documented via FastAPI OpenAPI/Swagger plus a short `CONTRACT` note mapping each prototype mock field to its API field (keep / rename / reject per ADR-024).

## Alternatives Considered

- **Server-side filtering + pagination now**: More surface than #3 needs; the UI filters client-side and does not consume server filters yet — not chosen.
- **Soft delete (`deleted_at` flag)**: Adds a flag every query must filter; restore/audit is not an MVP need — not chosen.

## Consequences

Small, documented surface the frontend can adopt in #14 without negotiating a new contract. Hard delete satisfies "no longer appears in derived totals". Filter/sort/pagination params are a forward-compatible, documented extension point. The `ResponseModel[T]` envelope is consistent with the rest of `apps/api`. See ADR-028 for the domain model this surface sits on top of.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
