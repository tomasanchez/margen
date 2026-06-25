---
project: margen
adr: 112
title: Monotributo ownership: shared scale, user-scoped snapshot, configured-owner capture
category: security
date: 2026-06-25
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-112: Monotributo ownership: shared scale, user-scoped snapshot, configured-owner capture

## Context

The AFIP monotributo **scale** (category thresholds) is shared reference data with no
owner; the `monotributo_snapshot` reflects the user's personal income/tax standing
computed from their transactions. The M2M capture endpoint (ADR-064) uses a static
bearer token with no user JWT. Ownership must be scoped appropriately without breaking
the existing capture mechanism.

## Decision

- **Keep the AFIP scale registry shared/ownerless**: no `user_id` column; it is
  reference data shared by all users.
- **Scope `monotributo_snapshot` to the user**: `GET /api/v1/monotributo` returns the
  caller's own standing, computed from the caller's transactions.
- **M2M capture** (`POST /api/v1/monotributo/capture`) computes and writes the snapshot
  for a **CONFIGURED owner `user_id`** read from an environment variable, preserving
  ADR-064's static-token mechanism unchanged. Monotributo capture is effectively
  single-owner for now.
- **Read models** (summaries, insights, monotributo standing) are scoped by filtering
  their source transactions by `user_id` — no new ownership column on the read models
  themselves.

## Alternatives Considered

- **Leave `monotributo_snapshot` shared**: any authenticated user would see the owner's
  income standing and tax category — not chosen.
- **Capture accepts `user_id` in the request payload**: the static-token caller would
  self-assert identity without any authentication check; a configured env-var owner is
  simpler and safer for the current single-owner reality — not chosen.

## Consequences

The capture endpoint reads a configured owner `user_id` from the environment. The
snapshot and standing are user-scoped. The scale stays a shared lookup table. A
single-owner limitation for capture is accepted and logged in ADR-114. ADR-064's
static-token mechanism is unchanged.

Relates to: ADR-064 (M2M static-token capture endpoint, unchanged), ADR-107
(ownership business decision), ADR-108 (explicit `user_id` threading), ADR-114
(single-owner capture as an accepted risk).

## Status History

- 2026-06-25: accepted
