---
project: margen
adr: 080
title: Multi-Row Review Table with Per-Line Include/Category Edit; Calm Unsupported-Bank Fallback
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-080: Multi-Row Review Table with Per-Line Include/Category Edit; Calm Unsupported-Bank Fallback

## Context

Unlike the ARCA invoice flow which yields a single prefilled form (ADR-072), a CC statement yields N line items that all need review before import. A per-line wizard or individual forms would be tedious for a typical statement with 12-40+ rows. The review interaction must let users correct categories and exclude unwanted lines (e.g. already-recorded items) without slowing down the common case. The error/unsupported-bank path must remain calm and non-blocking, consistent with ADR-037 and ADR-072.

## Decision

After a successful parse, show a statement review screen with:

- A **header strip**: detected bank/card (e.g. "Galicia VISA ·5771"), statement period, due date, and a non-blocking duplicate warning banner when the advisory dedupe flag is set (ADR-077).
- A **line-item table**: each row shows date, merchant name, amount, and an editable category selector (pre-populated by the guesser). Each row has an include/exclude toggle; fee lines and atypical rows default sensibly (e.g. fully-waived fees are already excluded by the parser and do not appear).
- A **running total** of included expenses shown persistently so the user can sanity-check against the statement total.
- A single **"Import N expenses"** primary action that calls `POST /statements/import` with the confirmed selection.

Unsupported or unparseable statements: show a calm inline message (not a modal error, not a toast-only message) explaining the bank is not yet supported and that manual entry is available — consistent with ADR-037 (calm, unavailable/loading experience) and ADR-072 (non-blocking fallback).

## Alternatives Considered

- **One form per line (wizard)**: Provides deep editing capability but is extremely tedious for 12+ rows — defeats the purpose of import; rejected.
- **Auto-import without review**: Violates the confirm-before-save contract established in ADR-068 and ADR-075; amounts matter and corrections must be possible before persist; rejected.

## Consequences

- The table UI is the primary new surface introduced by this feature; it requires a responsive MUI DataGrid or equivalent capable of inline editing of category selectors.
- The running total gives users an intuitive cross-check without requiring them to sum manually.
- The non-color include/exclude toggle must follow ADR-019 (accessibility, non-color status cues, keyboard navigation).
- Calm unsupported-bank messaging keeps manual entry always accessible — no dead ends.
- Relates to ADR-072 (invoice upload UX pattern), ADR-037 (calm errors and unavailable states), ADR-019 (accessibility), ADR-068 (confirm-before-save), ADR-075 (business scope).

## Status History

- 2026-06-14: accepted
