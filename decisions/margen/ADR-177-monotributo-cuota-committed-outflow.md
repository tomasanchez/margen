---
project: margen
adr: 177
title: Monotributo forward projection — fixed monthly cuota as a committed outflow
category: architecture
date: 2026-07-02
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-177: Monotributo forward projection — fixed monthly cuota as a committed outflow

## Context

ADR-170 deferred the Monotributo forward projection (crosses-ceiling estimate) to Slice 4. ADR-171 catalogued it among deferred panels. The forecast engine (ADR-176) is Slice 4's delivery vehicle.

The monotributo cuota has a distinct structure from a general recurring transaction: the amount is determined by the AFIP scale table (`monotributo_scale.py`, ADR-067), not by a captured transaction amount. The configured category's monthly `cuota_servicios` or `cuota_bienes` is a fixed, known ARS figure — the most predictable committed outflow a monotributista has.

Projecting the cuota forward fulfills the "panel deferred by ADR-170/ADR-171" — the owner can now see their future AFIP liability alongside other committed expenses.

## Decision

The forecast engine (ADR-176) includes the **configured monotributo category's monthly cuota** as a committed outflow stream in every projected future month within the horizon.

- The cuota amount is read from `monotributo_scale.py` (ADR-067) for the user's configured category (ADR-053) at engine run time.
- It is projected at a **monthly cadence** for each month in the horizon strictly after the month of the user's most recent recorded monotributo-category transaction (no-double-count rule from ADR-176).
- The stream label is `"Monotributo"` (or its i18n key equivalent — ADR-100).
- **Denomination is always ARS** — the monotributo cuota is an AFIP-ARS concept and must never be silently re-denominated to USD. When `currency=USD` is requested, the monotributo stream is reported separately with a flag indicating it is ARS-fixed and cannot be converted via a snapshot.
- **Distinct from turnover/ceiling projection**: this ADR covers the cuota outflow only, not an extrapolation of the user's invoiced revenue toward the annual category ceiling (that remains deferred per ADR-170).

## Alternatives Considered

- **Capture the cuota as a recurring transaction and let the general engine handle it**: The general engine reads `recurring_cadence` from transaction rows; the cuota amount is known from the scale table without any transaction. Forcing a transaction-based approach would require a synthetic/dummy transaction or a cron-created record — unnecessary complexity when the scale table is already authoritative; rejected.
- **Project turnover/ceiling trajectory alongside the cuota**: Different model — requires extrapolating income, not a fixed outflow; remains deferred per ADR-170; out of scope here.
- **Re-denominate cuota to USD at the live rate**: The cuota is an ARS tax obligation; displaying it in USD with a live rate would misrepresent a fixed ARS liability as fluctuating in USD — misleading; rejected.

## Consequences

- The forecast endpoint (ADR-176) gains one additional stream in every response: the monotributo cuota, always in ARS.
- When `currency=USD` is requested, the response must surface the ARS-fixed monotributo stream with a clear `ars_fixed: true` flag or equivalent so the frontend can render it distinctly (e.g., outside the USD total, with a caveat).
- The scale table (ADR-067) is read at forecast time, not cached per request; if the scale changes mid-year, the next forecast call reflects the updated cuota automatically.
- The owner can now see their total committed monthly ARS outflow including AFIP in one view — the primary value proposition of this stream.
- Relates to ADR-046 (trailing-12 monotributo reader — unchanged), ADR-053 (configured monotributo category), ADR-067 (versioned scale table — source of the cuota amount), ADR-100 (i18n — stream label), ADR-170 (deferred monotributo forward projection — this ADR fulfills the cuota part), ADR-171 (deferred panels — cuota projection now delivered), ADR-173 (commitment-driven forecast), ADR-176 (engine contract — monotributo is one stream within it).

## Status History

- 2026-07-02: accepted
