---
project: margen
adr: 072
title: "Upload-invoice UX: parse -> prefilled confirm -> save, with duplicate warning + attachment"
category: ux
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-072: Upload-invoice UX: parse -> prefilled confirm -> save, with duplicate warning + attachment

## Context

The Add flow currently opens a manual Add/Edit form. Importing from a PDF must fit naturally into that flow while preserving the confirm-before-save review established in ADR-068.

## Decision

Add an "Upload invoice (PDF)" entry point to the Add flow. On file pick:

1. Call the parse endpoint (ADR-070), showing a calm loading state (ADR-037).
2. Prefill the existing Add/Edit form with the extracted fields (amount, date, currency/FX block, name, category) for the user to review and edit.
3. On confirm, create the transaction with the document attached (ADR-071).

Show a calm, non-blocking duplicate warning when the parse response flags the invoice as already imported (ADR-071 dedupe). On the saved transaction, show an attachment badge/link to view or download the stored PDF.

Unparseable, non-ARCA, or QR-less PDF triggers a clear, calm error with a one-tap "enter manually" fallback to the normal Add form (acceptance criterion). English-only. Reuse ADR-037 calm states throughout.

Money display follows ADR-016/056 (frontend money formatting and display currency).

## Alternatives Considered

- **A separate import screen**: The Add/Edit form already models a full transaction; prefilling it keeps one review surface with all existing edit affordances — not chosen.

## Consequences

Importing reuses the existing Add/Edit form, minimising new UI surface. The transactions API client gains parse + attachment-aware create + an attachment fetch call. A clear manual fallback preserves user flow when parsing fails. The duplicate warning is advisory and non-blocking.

Relates to: ADR-016/056 (money display and display currency), ADR-033/037 (frontend client and calm states), ADR-068 (business flow), ADR-070 (parse endpoint), ADR-071 (document storage + dedupe flag), ADR-074 (frontend test strategy).

## Status History

- 2026-06-14: accepted
