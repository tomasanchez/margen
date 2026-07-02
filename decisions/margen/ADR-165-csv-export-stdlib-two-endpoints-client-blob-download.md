---
project: margen
adr: 165
title: CSV export via stdlib csv, two endpoints, authenticated fetch to blob download
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-165: CSV export via stdlib csv, two endpoints, authenticated fetch to blob download

## Context

ADR-128 specifies CSV export for the Reports slice: Python's stdlib `csv` module (no new backend dependency), CSV first with xlsx deferred. The shape of the export endpoints, the column set, and the client-side download mechanism need to be decided.

CSV download requires a Bearer token for authentication (ADR-064/ADR-092). A plain `<a href>` anchor link cannot attach an `Authorization` header, so the browser cannot follow the link directly to a protected endpoint.

## Decision

### Backend: two `text/csv` endpoints, stdlib only

**`GET /api/v1/reports/export/transactions`**

- Optional query params: `from_date=YYYY-MM-DD`, `to_date=YYYY-MM-DD`.
- Returns all of the authenticated user's transactions in that date range (or all-time if omitted).
- Column set (faithful, no omissions): `id`, `occurred_on`, `name`, `kind`, `category`, `amount`, `currency`, `fx_rate`, `fx_source`, `usd_amount`, `account_id`, `account_name`.
- Owner-scoped: joins through `accounts.user_id` (ADR-108/ADR-130/ADR-131).

**`GET /api/v1/reports/export/summary`**

- Required query param: `month=YYYY-MM`.
- Returns the per-category expense breakdown for that month, mirroring the `categories` array already computed by the summaries reader (ADR-042).
- Column set: `category`, `amount_ars`, `share_pct`, `delta_pct`.

Both endpoints:

- Use Python's stdlib `csv.writer` — no `openpyxl`, no `pandas`, no new dependency.
- Return `Content-Type: text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="<descriptive-name>.csv"` (e.g., `margen-transactions-2026-01-01-2026-06-30.csv`).
- Are protected by the standard JWT bearer guard (ADR-064/ADR-092).
- Are covered under the existing ownership-enforcement pattern (ADR-108/ADR-130).

### Frontend: authenticated fetch → Blob → programmatic download

Because the endpoints require a Bearer token, the client:

1. Calls the endpoint via the standard authenticated `fetch` (the same Tanstack Query HTTP client used for all API calls), receiving the CSV as a `Blob`.
2. Creates an ephemeral object URL (`URL.createObjectURL`), attaches it to a hidden `<a>` element, triggers `.click()`, then immediately revokes the URL.

This is the standard pattern for authenticated file downloads in SPAs; no new library is needed.

## Alternatives Considered

- **Plain `<a href>` anchor link**: Cannot attach an `Authorization` header — the browser sends a cookie-less, headerless GET; the protected endpoint returns 401; rejected.
- **Short-lived signed download URL (pre-signed)**: Generates a time-limited token, appends it as a query param so a plain anchor works — adds a token-generation endpoint, state management for expiry, and complexity that is not warranted for a personal-finance app with a single owner; rejected.
- **openpyxl / formatted xlsx now**: ADR-128 explicitly defers xlsx to avoid a new backend dependency and the coverage cost; rejected for MVP.
- **Single combined export endpoint**: One endpoint that returns all data in one CSV — loses granularity (transactions vs summary are structurally different; one flat file would be malformed or require awkward section headers); rejected.

## Consequences

- No new backend library is required; `csv` is stdlib, consistent with the ADR-128 decision.
- The transaction export includes the full FX snapshot columns (`fx_rate`, `fx_source`, `usd_amount`) so users have a faithful record of the money model (ADR-148/ADR-149) in their downloaded file.
- The authenticated-fetch-to-blob pattern is a frontend-only concern; it works identically for both endpoints and is reusable for any future binary download.
- xlsx remains a clean future enhancement: the two endpoints can gain an `?format=xlsx` query param later without changing the URL structure or the client download flow.
- Relates to ADR-042 (summaries reader reused for summary export), ADR-064/ADR-092 (JWT bearer auth), ADR-108/ADR-130/ADR-131 (ownership scoping), ADR-128 (CSV-first, xlsx-later decision), ADR-148/ADR-149 (FX snapshot columns included in transaction export), ADR-163 (reports page that hosts the export buttons).

## Status History

- 2026-07-02: accepted
