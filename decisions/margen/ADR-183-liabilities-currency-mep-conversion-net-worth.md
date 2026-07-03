---
project: margen
adr: 183
title: Liabilities currency — native ARS/USD figures convert onto MEP-denominated net-worth total
category: data
date: 2026-07-03
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-183: Liabilities currency — native ARS/USD figures convert onto MEP-denominated net-worth total

## Context

ADR-181 derives installment liabilities from per-transaction amounts. Transactions are denominated in their native currency (ARS or USD, per ADR-148/ADR-149). The net-worth `total` (ADR-122) is denominated in the owner's preferred currency, converted via the MEP rate (ADR-123). For `net_after_liabilities` (ADR-180) to be meaningful, liability amounts must be expressed in the same currency as `total`.

## Decision

Liability amounts (per-transaction ARS or USD figures from ADR-181) are **converted to the net-worth display currency using the same MEP rate that net worth uses (ADR-123)**:

- If the MEP rate is available at read time: convert at that rate.
- If the MEP rate is unavailable: report liability amounts in their native denomination, mark the conversion as degraded (consistent with the `unconverted_count` pattern in ADR-168/ADR-176), and surface the degraded state to the UI.

This is consistent with the FX-snapshot / denomination discipline established in ADR-148 (per-transaction FX snapshot), ADR-152 (native multi-currency budgets converted at live rate), and ADR-168 (denomination toggle logic).

**No new FX source**: the MEP rate already fetched for net-worth display is reused for liability conversion. No additional API call.

**Mixed-denomination streams:** if an installment stream is denominated in USD and the display currency is ARS, the stream's `cuota_amount` in USD is converted to ARS at MEP. If the display currency is USD and the stream is ARS, convert ARS to USD at MEP. Streams without a resolvable rate contribute to `unconverted_count` and are excluded from `liabilities.sum`.

## Amendment (2026-07-03) — convert at the LIVE display rate, not a backend snapshot

The first implementation converted the liability server-side using the backend's most-recent confirmed transaction `fx_rate` (a per-transaction *snapshot* rate). But net-worth **display** is rendered at the **live** MEP rate client-side (ADR-133), so subtracting a snapshot-rate liability from a live-rate assets figure made "Net of commitments" incoherent whenever a USD installment tail existed and the two rates had drifted — contradicting this ADR's own stated intent to use the live rate (see the rejected snapshot alternative below).

Corrected decision: the liabilities read model exposes the installment tail as a **native ARS/USD breakdown** (unconverted), and the **frontend converts it at the SAME live MEP rate it uses for the net-worth assets headline** (ADR-133). Both sides of `net worth − liabilities` therefore use one rate, and "Net of commitments" is coherent. The server still returns a converted `installments`/`total`/`net_after_liabilities` (at the backend rate) for API/test completeness, but the displayed card derives its figures from the native breakdown at the live rate. This *adopts* the previously-rejected "separate ARS/USD subtotals" alternative, because it is what makes live-rate coherence possible.

Known bounded limitation (accepted, not fixed here): the Concept-A committed-spend accent on the **Home** view annotates a live-rate Expenses figure with snapshot-denominated committed figures (ADR-152/168), so on a USD Home view the accent is approximate; the Budget page is coherent (spend + accent both snapshot-denominated in the budget currency). This is the same live-vs-snapshot tension logged in ADR-154 and is left as-is.

## Alternatives Considered

- **Fixed ARS-only liabilities (no FX conversion)**: Simpler but wrong when the owner holds USD installments (e.g., a USD-denominated loan); the ARS-only total would understate or misstate the obligation in a USD-display view; rejected.
- **Separate ARS and USD subtotals in `liabilities`**: More explicit but adds response complexity; the established pattern (single display currency with degraded fallback) is already understood by the frontend; rejected.
- **Use the FX snapshot stored on each transaction (ADR-148/ADR-149)**: The per-transaction snapshot reflects the rate at purchase time, not the current value of the obligation; using historical rates for a current liability figure would misrepresent the present cost; rejected in favour of the live MEP rate.

## Consequences

- The liabilities read model requires the same MEP rate fetch already performed for net-worth; no new external dependency.
- `net_after_liabilities` is coherent with `total` — both are in the same display currency at the same rate — making subtraction meaningful.
- If the MEP rate is unavailable, `net_after_liabilities` is suppressed or shown with a degraded warning rather than silently using a stale rate; consistent with ADR-123's handling.
- The `unconverted_count` field (or equivalent) in the liabilities breakdown signals how many streams could not be converted, so the UI can show a "partial" caveat.
- Relates to ADR-122 (net-worth `total` — `net_after_liabilities` must use the same currency), ADR-123 (MEP rate — source for conversion), ADR-148 (per-transaction FX snapshot — not used here for current liabilities), ADR-149 (client-side FX capture discipline), ADR-152 (multi-currency conversion pattern reused), ADR-168 (denomination toggle and unconverted_count pattern), ADR-180 (net-worth liabilities read model that this ADR feeds), ADR-181 (installment liability derivation — provides native ARS/USD amounts).

## Status History

- 2026-07-03: accepted
- 2026-07-03: amended — liabilities convert at the LIVE display rate (ADR-133) via a native ARS/USD breakdown converted client-side, not the backend snapshot rate; adopts the native-subtotal approach originally rejected. Notes the Home committed-accent live-vs-snapshot limitation (ADR-154).
