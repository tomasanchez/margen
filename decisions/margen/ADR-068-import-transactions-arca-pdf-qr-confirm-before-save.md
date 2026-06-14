---
project: margen
adr: 068
title: Import transactions from ARCA invoice PDFs (QR-first, confirm-before-save)
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-068: Import transactions from ARCA invoice PDFs (QR-first, confirm-before-save)

## Context

Monotributistas already hold ARCA-generated invoice PDFs. Re-typing them into Margen is tedious and error-prone (GitHub issue #26). Users want to upload a PDF and have Margen create the real transaction, ideally keeping the original document.

## Decision

Support uploading a single ARCA invoice PDF. Parse it primarily via the embedded AFIP QR code, which carries structured JSON (`ver`, `fecha`, `cuit` (emisor), `ptoVta`, `tipoCmp`, `nroCmp`, `importe`, `moneda`, `ctz`, `tipoCodAut`, `codAut`, `nroDocRec`). PDF text-extraction is the fallback for fields the QR does not carry (human-readable client/receptor name) and when no QR is found.

Show the extracted fields for the user to review and edit before any data is persisted — a confirm-before-save step that mirrors the FX suggest-confirm flow established in ADR-044/045. On confirm, create a transaction (`kind=invoice`, `counts_toward_monotributo=true` per ADR-027/031).

Field mapping:

- `importe` -> `amount` (ARS-equivalent)
- `fecha` -> `occurred_on`
- `moneda != ARS` -> currency USD with `usd_amount` + `fx_rate=ctz` + `fx_rate_type='official'` (the invoice's declared rate) + `fx_rate_as_of=fecha`, reusing the FX block from ADR-044/045
- `name` -> receptor (client) name from PDF text, falling back to `"Invoice <ptoVta>-<nroCmp>"`
- Category defaults (e.g. Income / Services), all editable at the confirm step

## Alternatives Considered

- **OCR/layout text-scraping as primary**: The AFIP QR carries the exact structured fields; QR decode is far more reliable than scraping the visual layout — not chosen.
- **Auto-create without confirm**: Extraction can be imperfect and amounts are fiscal; the user must review before the transaction counts toward Monotributo — not chosen.

## Consequences

Fast, trustworthy invoice entry from the canonical fiscal document. Defines the parser (ADR-069), the parse and create endpoints (ADR-070), document storage (ADR-071), the upload UX (ADR-072), and scope/safety boundaries (ADR-073). Assumes native ARCA-generated PDFs with an embedded QR; scanned or photographed paper invoices are out of scope (ADR-073).

Relates to: ADR-024/027/031 (transaction model, `kind`, `counts_toward_monotributo`, lenient validation), ADR-044/045 (FX block fields and suggest-confirm pattern), ADR-046/048 (Monotributo context), ADR-030 (ResponseModel envelope), ADR-025 (Decimal money).

## Status History

- 2026-06-14: accepted
