---
project: margen
adr: 51
title: "Monotributo MVP scope boundaries and accepted risks"
category: risks
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-051: Monotributo MVP scope boundaries and accepted risks

## Context

Issue #8 lists edge cases and the team is shipping an MVP slice. Some realities are explicitly deferred to later issues. Without recording these deferrals, future contributors may treat missing behavior as bugs rather than known omissions.

The calculation rules live in ADR-046; the endpoint in ADR-047; the config/data model in ADR-048; UX wiring in ADR-049; test coverage in ADR-050.

## Decision

**Deferred — out of scope, recorded:**

- Automatic AFIP threshold/category ceiling updates: the A–K scale is a manually maintained constant (ADR-048); staleness is an accepted risk, mitigated by versioning the constant and surfacing the scale year in the UI.
- Goods/bienes activity caps and fees: services (`cuotaServicios`) assumed throughout MVP (ADR-046).
- Credit-note and canceled-invoice handling: no negative/cancellation transaction model exists yet; premature for this slice.
- Full settings surface and multi-user/auth: deferred to issue #10.

**Accepted and handled in-UI:**

- Unknown or first-period low data: projection is shown with a low-confidence "estimate, assumes steady pace" note (ADR-046, ADR-049).
- Over-limit state: explicit "Over your limit" status band (ADR-046).
- Manual category change: supported via the minimal PATCH introduced in ADR-048.

## Alternatives Considered

- **Block on official AFIP API integration**: out of scope for MVP; manually maintained reference data is acceptable per the issue brief.
- **Model credit notes now**: no cancellation model exists; introducing it would be premature and out of scope for this slice.

## Consequences

A focused, shippable MVP with explicitly recorded deferrals. Future issues (#10 for settings/auth, a future AFIP-sync issue, goods-activity support, credit-note handling) have a clear starting point and will not re-debate these scope boundaries. The staleness risk on AFIP thresholds is known and mitigated operationally.

## Status History

- 2026-06-14: accepted

> **Update (2026-06-14): scale verified + refreshed.** The placeholder ceilings in
> `monotributo_scale.py` (carried from the 2025 table, `TODO(ADR-051)`) were replaced with the
> official ARCA scale in effect **February–July 2026** (annual ceilings + servicios/bienes cuotas;
> `SCALE_VERSION = "2026-02"`), cross-checked against the frontend's existing AFIP-2026 values. The
> staleness risk now reduces to keeping the constant current each semester (≈ February and August) —
> the scale module documents the cadence and the next bump. Automatic ARCA ingestion remains out of
> scope.
