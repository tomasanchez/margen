---
project: margen
adr: 117
title: Normalize transaction bank to bank-level + separate card-detail field
category: data
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-117: Normalize transaction bank to bank-level + separate card-detail field

## Context

A transaction's payment attribution was stored in a single free-text field (`payment_method` in the backend, exposed to the frontend as `bank`). Manually-entered rows used composite labels such as `Galicia · Visa`, `Santander · Mastercard`, `Mercado Pago`, `Brubank`, `Deel`, and `Transfer`. The statement importer (ADR-079), however, wrote card-level labels — `Galicia VISA ·5771`, `Santander AMEX`, `Santander VISA` — because its mapping table composed issuer, network, and last-four into a single string.

The Transactions bank filter matched by exact string equality against this field. Selecting `Santander · Mastercard` therefore never matched imported `Santander AMEX` or `Santander VISA` rows. Filtering by a bank did not find all of that bank's transactions, and the filter's value set and the import's value set were structurally incompatible.

The user requested that selecting a bank match every transaction attributed to that bank regardless of which card originated it, and that both the stored data and the filter be updated accordingly.

## Decision

Split payment attribution into two fields:

1. **`bank`** — the normalized, filterable attribution. One of: `Galicia`, `Santander`, `Mercado Pago`, `Brubank`, `Deel`, `Transfer`. Card-issuing banks collapse to the bank name; non-bank sources (Mercado Pago, Brubank, Deel, Transfer) are kept as-is. This is the value used for all filtering and grouping. `KNOWN_PAYMENT_METHODS` in ADR-024 is updated to this bank set.

2. **`card`** — an optional string capturing the card-level detail (e.g. `"AMEX ·1234"`, `"VISA ·5771"`, `"Visa"`, `"Mastercard"`). Kept for display purposes only; not used in filtering or grouping. User-editable forms expose only `bank`; `card` is set by the statement importer and preserved unchanged across manual edits.

**Migration**: An Alembic migration backfills the new `card` column and normalizes existing `bank` values in-place. For each existing row the old composite label is parsed: the bank portion becomes the normalized `bank` value and the remainder becomes `card`. Rows with unrecognized labels are kept as-is (`bank` = original label, `card` = null) to avoid data loss. Applying the migration to Supabase performs a one-way, deterministic rewrite of all production rows.

**Statement parsers** (ADR-079) are updated to emit `bank` and `card` as separate fields instead of composing them into a single `payment_method` string.

**Bank filter** (ADR-116) matches against `bank` exactly. With normalized values this is now correct across all cards issued by the same bank.

## Alternatives Considered

- **Frontend-only prefix grouping of the composite label**: Group filter options by detecting the bank prefix at render time, without changing the DB schema. Leaves the database unqueryable by bank and is fragile against label variations. Rejected.
- **Collapse to Galicia/Santander only with an "Other" bucket**: Simpler normalization but loses Mercado Pago, Brubank, Deel, and Transfer attribution. Rejected by the user — those sources are meaningful for spending analysis.
- **Drop card detail on collapse**: Normalize `bank` but discard the card information entirely. Loses which card a charge came from (e.g. AMEX vs. VISA within Santander), which the user wanted for display. Rejected; card detail is preserved in the `card` field.

## Consequences

- **Amends ADR-024**: `KNOWN_PAYMENT_METHODS` is now the bank-level set {Galicia, Santander, Mercado Pago, Brubank, Deel, Transfer}. The old composite labels are no longer valid stored values.
- **Amends ADR-079**: The statement-line → transaction field mapping now populates `bank` and `card` separately instead of a single composite `payment_method` string.
- **Relates to ADR-116**: The `bank` URL filter param validated in `validateSearch` now matches against the normalized bank set defined here. Its valid value set updates accordingly.
- The JSON API contract gains `card: string | null`; `bank` holds only the normalized bank name.
- The Add/Edit transaction form exposes `bank` (a select over the known set); `card` is import-set and not user-editable, but is preserved when a user edits a previously-imported transaction.
- The Alembic migration is one-way and deterministic. Rows with labels that do not match the known composite patterns are left with their original label as `bank` and `card = null`, surfacing them for manual review rather than silently corrupting data.

## Status History

- 2026-06-27: accepted
