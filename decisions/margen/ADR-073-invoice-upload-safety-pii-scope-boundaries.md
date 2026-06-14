---
project: margen
adr: 073
title: Invoice-upload safety, PII, and scope boundaries
category: security
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-073: Invoice-upload safety, PII, and scope boundaries

## Context

Uploads are untrusted binary input and ARCA invoices carry PII (CUITs, amounts, business names). There is no authentication or multi-user model yet. Several adjacent capabilities are desirable in future but out of scope for this iteration.

## Decision

**Upload safety**: Accept PDF only — validate by `Content-Type` AND magic bytes (`%PDF`). Enforce a size cap (e.g. 10 MB). Never execute or transform beyond parsing. Cap parsing work (page count and time bounds) to avoid resource abuse.

**PII / security posture**: Stored invoice PDFs and extracted data are PII held in Postgres with no authentication layer yet. This is an explicitly accepted MVP risk, to be revisited when auth and object storage land (encryption at rest, per-user access control). The risk is recorded here.

**`ctz -> fx_rate_type='official'` assumption**: The invoice's declared exchange rate is mapped to `fx_rate_type='official'`. This is an assumption the user can override at the confirm step (ADR-068).

**Deferred / out of scope**:

- Vectorizing / semantic search and AI Q&A over stored documents (prepared via stored text + pgvector bundle; no embedding dependency now — ADR-071)
- Object storage / Azure Blob (unblocked by the DocumentStore port — ADR-071)
- Bulk or multi-file upload
- Email ingestion
- Automatic ARCA account sync
- OCR of scanned or photographed paper invoices (native ARCA-generated PDFs with a QR are assumed throughout)

## Alternatives Considered

- **Accept any file type**: Unsafe; PDF-only with a magic-byte check bounds the attack surface to the parsing code path — not chosen.
- **Block import until auth exists**: Over-cautious for a single-user MVP; the PII risk is explicitly documented and time-boxed to the pre-auth period — not chosen.

## Consequences

A bounded, reviewable upload surface with documented, time-boxed security debt (PII without auth). Clear deferrals prevent scope creep. The `ctz` mapping assumption is surfaced to the user at confirm rather than silently applied. The auth + object-storage work pays down this debt when it arrives.

Relates to: ADR-064 (bearer token auth on capture endpoint, as a precedent), ADR-068 (import flow), ADR-069 (parser with page/time bounds), ADR-070 (file constraints at the endpoint), ADR-071 (DocumentStore port for future Blob migration).

## Status History

- 2026-06-14: accepted
