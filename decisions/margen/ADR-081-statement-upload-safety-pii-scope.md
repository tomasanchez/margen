---
project: margen
adr: 081
title: Statement Upload Safety + PII Scope
category: security
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-081: Statement Upload Safety + PII Scope

## Context

CC statements carry substantially more PII than ARCA invoices: full legal name, home address, national ID (CUIT/DNI), account numbers, card last-4, and a complete purchase history. The upload endpoint must apply the same structural safety controls as the invoice upload (ADR-073) and be explicit about which PII is retained and why. Test fixtures must not contain real personal data.

## Decision

Apply the following controls, mirroring ADR-073:

- Validate uploads by `Content-Type: application/pdf` header AND `%PDF` magic-byte prefix; reject any file that fails either check with HTTP 415.
- Cap upload size at **10 MiB**; reject larger files with HTTP 413.
- Accept PDF only — no images, scanned pages, or other formats (scanned statements are out of scope for MVP).

PII retention scope (accepted for a single-user personal app):

- The raw PDF bytes and extracted text are stored in Postgres (ADR-077). This includes the cardholder name, address, and statement number — retained for audit, reference, and dedupe.
- `card_last4` is retained as part of the `statement_document` record for dedupe natural key and display; it is not a security-sensitive credential.
- Account numbers beyond `card_last4` are present in the stored PDF bytes but are not extracted into structured columns.

Test fixture requirement: any sanitized PDF fixture committed to the repository **must have real name, address, account numbers, and card numbers scrubbed** before commit. The CI gate must never run against an actual personal statement.

Out of scope for MVP: scanned/photographed statements, encryption at rest beyond Postgres defaults, object storage migration (deferred to the ADR-071/ADR-077 storage port).

## Alternatives Considered

- **Extract and discard PII immediately after parsing**: Reduces stored PII but eliminates the ability to re-parse or audit the original document; inconsistent with invoice storage (ADR-071); rejected for MVP.
- **Object storage with separate access controls**: Deferred — the ADR-071/ADR-077 storage port makes this a drop-in swap when needed.

## Consequences

- The 10 MiB cap and PDF-only validation are consistent with the invoice upload gate (ADR-073) — shared validation logic is feasible.
- Storing the raw PDF in Postgres is acceptable at personal-use volumes; if the app scales to multi-user it will need encryption at rest and object storage migration.
- Committing sanitized fixtures is a team norm; a pre-commit hook or CI check should be considered to detect accidental real-data commits.
- Relates to ADR-073 (invoice upload safety), ADR-071 (storage port), ADR-077 (statement_document schema and stored fields).

## Status History

- 2026-06-14: accepted
