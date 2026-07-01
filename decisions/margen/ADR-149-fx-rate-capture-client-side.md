---
project: margen
adr: 149
title: FX rate capture stays client-side; backend materializes usd_amount arithmetically
category: architecture
date: 2026-06-30
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-149: FX rate capture stays client-side; backend materializes usd_amount arithmetically

## Context

ADR-044 and ADR-133 establish that FX rate data flows from client-side sources (dolarapi `fxClient`) to the backend; no server-side FX feed exists. ADR-148 introduces a per-transaction FX snapshot (`fx_rate`, `fx_source`, `usd_amount`). A key design question is which side of the write boundary is responsible for fetching and recording the rate. Adding a server-side FX fetch would partially reverse ADR-044/133 and introduce a new external dependency on the write path.

For statement imports, the server parses the uploaded file and creates transaction rows; the rate cannot be captured at parse time because the server has no FX feed and the correct rate for backdated rows is date-specific.

## Decision

The CLIENT supplies `fx_rate` and `fx_source` on every create or patch write. The backend materializes `usd_amount = round(amount ÷ fx_rate, 2)` as pure arithmetic and persists all three fields. No server-side FX call is made; the backend treats the supplied rate as authoritative and only validates the arithmetic.

**Manual add / edit:** the user picks a rate via the existing suggest-confirm flow (ADR-044/045); the form sends `fx_rate` + `fx_source` alongside `amount`. The preferred rate source (ADR-151) drives the initial suggestion.

**Statement import:** the server parses and stores rows without a snapshot (all three fields null). The client performs a follow-up rate-fill step — iterating rows without a snapshot and patching each with the appropriate historical rate, using the preferred rate source (ADR-151) and a historical FX lookup (ADR-150).

Rows may transiently exist without a snapshot between import and the rate-fill step; the spend-exclusion rule (ADR-152) handles them without silent omission.

## Alternatives Considered

- **Server captures rate at write time**: The backend calls dolarapi on every USD transaction create/patch — adds a server-side external dependency, introduces a failure mode on the write path, and partially reverses ADR-044/133; rejected.
- **Capture-time current rate only (no backdated support)**: Always use today's rate regardless of `occurred_on` — inaccurate for backdated imports and statement rows; rejected. The client can supply the historically correct rate for any date.
- **Client sends `usd_amount` directly (no server recompute)**: The server trusts the client-supplied `usd_amount` with no recompute — allows a stale or inconsistent value to persist silently; rejected. The server must always recompute from `amount ÷ fx_rate` to maintain round-trip fidelity.

## Consequences

- ADR-044/133 (FX is client-side, no new server dependency) is fully preserved.
- The write API gains two new optional fields (`fx_rate`, `fx_source`) on the transaction create/patch contract; `usd_amount` is server-computed and read-only from the client's perspective.
- Statement imports gain a client-side rate-fill step; rows can transiently lack a snapshot (safe per ADR-152).
- The backend materialization is a deterministic pure computation (division + rounding) — trivially unit-testable, no external I/O.
- Relates to ADR-025 (Decimal precision conventions), ADR-044/133 (client-side FX), ADR-045 (suggest-confirm flow), ADR-148 (snapshot fields), ADR-150 (backfill of existing rows), ADR-151 (preferred rate source), ADR-152 (spend-exclusion rule for null-snapshot rows).

## Status History

- 2026-06-30: accepted
