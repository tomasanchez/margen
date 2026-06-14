---
project: margen
adr: 076
title: Pluggable Bank-Statement Parser Registry; Narrow PyMuPDF Boundary; Galicia VISA First
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-076: Pluggable Bank-Statement Parser Registry; Narrow PyMuPDF Boundary; Galicia VISA First

## Context

Multiple bank/card issuers must eventually be supported without the user having to declare which bank their statement is from. CC statements are native-text PDFs with no AFIP QR code (unlike ARCA invoices), so issuer detection must derive from the document's own text content. A hard-coded single-issuer parser would require a refactor to add bank #2. The PyMuPDF native dependency boundary must be kept narrow (mirror ADR-069) so that line-parsing and category logic remain pure and unit-testable without the native library.

## Decision

Implement a detector registry of bank-specific parsers. Each parser in the registry exposes:

1. A fingerprint check — examines extracted text for issuer markers (bank CUIT, network name, branding strings). Galicia VISA is detected by CUIT `30-50000173-5`, the string "VISA", and Galicia branding text.
2. A parse function — extracts the line items and statement metadata from the matched document.

The native dependency boundary is kept narrow: PyMuPDF/fitz is used only for text and word extraction in a dedicated adapter; all line-parsing regex logic and the category guesser are pure Python, callable in unit tests without PyMuPDF present (mirroring ADR-069). MVP ships only the Galicia VISA parser; new banks plug into the registry with no changes to calling code. An unrecognized issuer returns a calm "unsupported statement" status and never raises an unhandled exception — manual entry remains available.

## Alternatives Considered

- **Single hardcoded parser**: Works for Galicia only; requires structural refactor for every new bank — rejected.
- **OCR / layout-coordinate scraping as primary strategy**: Native-text extraction via regex is sufficient for PDF statements that are not scanned; OCR adds dependency weight and accuracy risk — rejected as primary approach (can be added per-parser later).

## Consequences

- New bank parsers are additive; no existing code changes when bank #2 ships.
- The narrow native boundary means the bulk of logic is covered by fast, isolated unit tests (see ADR-082).
- Fingerprint false-positives are possible if two banks share markers; each parser's fingerprint must be specific enough to avoid collisions.
- Unsupported banks degrade gracefully — no crash, no data loss, manual entry always works.
- Relates to ADR-069 (narrow native PyMuPDF boundary for ARCA parser), ADR-072 (calm fallback UX), ADR-075 (business scope), ADR-082 (test strategy).

## Status History

- 2026-06-14: accepted
