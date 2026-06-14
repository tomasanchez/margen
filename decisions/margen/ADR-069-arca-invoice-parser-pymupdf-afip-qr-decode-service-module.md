---
project: margen
adr: 069
title: "ARCA invoice parser: PyMuPDF render/text + AFIP QR decode, as a service module"
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-069: ARCA invoice parser: PyMuPDF render/text + AFIP QR decode, as a service module

## Context

Decoding the AFIP QR requires rendering the PDF page to an image and then decoding the QR barcode; the text-extraction fallback and the client name also require reading PDF content. Library choices carry native-dependency and container implications (deployment infrastructure not yet built).

## Decision

Implement the parser as a pure-ish service module in the `margen_api` service layer. Use **PyMuPDF** (`fitz`) to extract text and render page(s) to images — no poppler needed. Decode the QR barcode with **pyzbar**, which wraps the native `zbar` library (a small `apt` package to be added to the eventual container image).

The AFIP QR encodes a URL of the form `https://www.afip.gob.ar/fe/qr/?p=<base64url(JSON)>`. The parser:

1. Extracts the `p` query parameter from the decoded URL.
2. Base64url-decodes and JSON-parses the payload.
3. Validates the expected fields (`ver`, `fecha`, `cuit`, `ptoVta`, `tipoCmp`, `nroCmp`, `importe`, `moneda`, `ctz`, `tipoCodAut`, `codAut`, `nroDocRec`).
4. Falls back to text-extraction when no QR is present or decoding fails.

The parser returns a structured result (QR fields + extracted text + parse status). It performs NO persistence and NO HTTP calls — it is unit-testable with fixture PDFs and fixture QR payloads.

## Alternatives Considered

- **pdf2image + poppler**: Adds an extra native dependency (poppler); PyMuPDF renders pages and extracts text in a single library — not chosen.
- **Pure-Python QR decoder**: Unreliable on real renders; pyzbar / zbar is the robust, widely-used standard — not chosen.
- **External parsing API**: Sends fiscal PDFs off-box; unnecessary when the QR is fully self-describing — not chosen.

## Consequences

One PDF library (PyMuPDF) and one QR library (pyzbar) with a native `zbar` dependency the container must install. The parser is isolated and fully testable with sample AFIP QR payloads and small fixture PDFs (see ADR-074). The AFIP QR-URL format is an external contract that could change — low risk, documented.

Relates to: ADR-068 (overall import flow), ADR-070 (endpoints that invoke the parser), ADR-074 (test strategy).

## Status History

- 2026-06-14: accepted
