---
project: margen
adr: 209
title: "Per-person receivable PDF: server-side PyMuPDF, English (en-US), outstanding + itemized"
category: architecture
date: 2026-08-28
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-209: Per-person receivable PDF: server-side PyMuPDF, English (en-US), outstanding + itemized

## Context

The owner wants a shareable document they can hand a debtor to justify what they owe — the person's name, the total outstanding, and the itemized entries backing it up. The backend already depends on PyMuPDF (`fitz`) for statement/invoice parsing (ADR-069/076), and the CSV export routes already establish the attachment/streamed-response precedent for generated-file downloads. The owner's explicit preference is that this document reads in English regardless of the app's own UI language or its ARS domain-constant formatting (ADR-102), since it is meant to be handed to another person and the owner wants a fixed, presentable format.

## Decision

A new download endpoint builds the PDF **server-side using PyMuPDF**, reusing the existing `fitz` dependency and the attachment/streamed-response pattern already established by the CSV export routes. The PDF contains: the person's name, their current total outstanding (ADR-204/206), and the itemized `receivable_item` entries (date / amount / detail) that justify that total. **v1 shows outstanding items only** — settled/paid history is out of scope for this slice and deferred to a future extension.

The PDF is rendered in **English (en-US)** — both labels and number formatting — with amounts still denominated in ARS. This is a deliberate override of the app's default es-AR domain-constant formatting (ADR-102) for this one shareable, hand-to-the-person document, per the owner's explicit choice; it does not change ADR-102's rule for any in-app surface.

## Alternatives Considered

- **Client-side PDF generation** (e.g., a browser PDF library): would introduce a new frontend dependency and diverge from the established `fitz`/server-side generation precedent already used for statements and invoices — rejected.
- **Render the PDF in es-AR or in whatever the current UI language is**: would match ADR-102's default, but the owner explicitly wants a fixed English document regardless of their own UI language setting, since the recipient is a third party and consistency of the handed-over document matters more than matching in-app locale — rejected.

## Consequences

- Requires a new server-side PDF-builder module and a new download route, following the existing CSV-export attachment/streamed-response pattern.
- Requires a small en-US-specific number/date formatting helper used ONLY by this document — it must not be confused with or replace the es-AR domain-constant formatter used everywhere else in the app (ADR-102).
- Paid/settled history in the PDF is a known, explicitly deferred future extension (tracked alongside ADR-206's settlement model).
- Relates to ADR-069/076 (PyMuPDF/`fitz` dependency precedent), ADR-102 (es-AR domain-constant formatting — this ADR is a deliberate, scoped exception for one document), ADR-204/206 (outstanding calculation this PDF renders), ADR-208 (UI entry point for the download).

## Status History

- 2026-08-28: accepted
- 2026-08-28: AMENDED — the fixed **English (en-US)** decision is superseded at owner request. The PDF now **follows the active app language (es-AR or en-US)**: localized labels + locale-appropriate number/date formatting (es-AR `1.234,56` + `DD/MM/YYYY`; en-US `1,234.56` + `MM/DD/YYYY`), ARS amounts either way. The frontend passes the active i18n locale to the export endpoint. Also per owner: the document should read **plainly and informally**, include simple **icons** next to fields (so an informal recipient reads it easily), and contain **no em-dashes**. Still outstanding-only (paid history remains deferred).
- 2026-08-29: AMENDED by ADR-210 — adds a "Covered by you" ("Cubierto por vos") section below the outstanding section, listing pardoned items and their total covered amount, following the same language/icon/no-em-dash rules.
- 2026-08-29: AMENDED — two changes to the covered/paid history, since the document is handed to the DEBTOR. (1) The covered section now reads with the OWNER'S name instead of the ambiguous "you": es "Cubierto por {owner}" / total "Total cubierto por {owner}:"; en "Covered by {owner}" / total "{owner} covered:". The owner name is derived at the route from the verified JWT (mirroring the web AccountMenu chain: `user_metadata.full_name` then `.name` then the email local-part); when it cannot be derived the "by {owner}" suffix is dropped gracefully (es "Cubierto" / en "Covered"). (2) A new **"Payments received"** ("Pagos recibidos") paid-history section is added below the covered section, listing ALL of the person's paybacks (date + amount, both manual and matched-income) newest-first with a "Total paid:" / "Total pagado:" total, omitted when the person has never paid. Payments are exposed via a new `payments` field on the `get_person` read model. Same language/icon/no-dash rules; net worth still untouched (ADR-205). Paid history is no longer a deferred extension.
