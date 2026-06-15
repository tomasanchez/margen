---
project: margen
adr: 075
title: Import Credit-Card Statement PDFs as Line-Item Expenses (Confirm-Before-Save)
category: business
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-075: Import Credit-Card Statement PDFs as Line-Item Expenses (Confirm-Before-Save)

## Context

Users hold monthly credit-card statement PDFs (e.g. Visa Galicia). Re-typing each purchase into Margen is tedious and error-prone. They want to upload the statement and have Margen create the individual expense transactions automatically, while keeping the original PDF for reference. This mirrors the ARCA invoice import flow established in ADR-068 through ADR-074.

## Decision

Support uploading a single CC statement PDF. Parse the "DETALLE DEL CONSUMO" section; each purchase line becomes its own expense transaction (`kind=expense`) dated on its purchase date, with a guessed category. The statement TOTAL A PAGAR is NOT recorded — it merely settles the card and recording it would double-count spending already captured as individual transactions. The bank/card issuer is auto-recognized from the document text (no user-provided bank flag). After parsing, all extracted line items are shown in an editable multi-row review table where the user can confirm, adjust, or exclude rows before anything is persisted (confirm-before-save), mirroring ADR-068 and ADR-072.

## Alternatives Considered

- **Single expense on due date**: Record the whole statement total as one expense on the due date — loses per-purchase categories and dates; chosen against.
- **Hybrid (line items + statement obligation)**: Track both individual purchases and the payment obligation — risks double-counting, adds complexity; deferred.
- **Auto-create without confirm**: Persist all parsed lines immediately without a review step — amounts matter and cannot be recovered without manual deletion; rejected to maintain confirm-before-save discipline.

## Consequences

- Each CC statement yields N independent `kind=expense` transactions, fully queryable and categorised.
- The statement TOTAL A PAGAR is intentionally omitted; users must understand the import scope to avoid confusion.
- The confirm-before-save step allows category correction and line exclusion, reducing noise from fees or misidentified lines.
- Future CC cards require only a new bank parser (see ADR-076) — the business flow is bank-agnostic.
- Relates to ADR-024 (transaction model and field mapping), ADR-027 (kind as source of truth), ADR-031 (lenient validation), ADR-025 (Decimal money), ADR-068 (confirm-before-save for invoice import), ADR-072 (upload UX pattern).

## Status History

- 2026-06-14: accepted
