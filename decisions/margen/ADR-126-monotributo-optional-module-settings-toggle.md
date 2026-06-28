---
project: margen
adr: 126
title: Monotributo becomes an optional module via a per-user Settings toggle
category: architecture
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-126: Monotributo becomes an optional module via a per-user Settings toggle

## Context

The PFM repositioning (ADR-119) demotes monotributo from the core to an optional module. Existing users rely on monotributo features and must not have them removed without notice. New users who are not Argentine freelancers should not see cluttering monotributo UI.

## Decision

Add a `monotributo_enabled` boolean flag to `app_settings` (ADR-053/054), defaulting to `false` for new users. A data migration sets it to `true` for all existing users who already have settings rows.

When the flag is `off`:
- Monotributo nav item is hidden.
- Monotributo Home card is hidden.
- The Monotributo page is inaccessible (guarded route or 404).

The M2M capture endpoint (ADR-064) is unaffected — it remains active regardless of the UI toggle, as it is a backend-only channel used by the cron job.

Amends ADR-053 and ADR-054 (settings scope now includes a module visibility flag).

## Alternatives Considered

- **Onboarding region/profile gating**: Show/hide monotributo based on a detected or declared user region — more build, more complexity, deferred — rejected.
- **Always-on but de-emphasized**: Keep monotributo visible everywhere but smaller — clutters the general PFM experience for non-AR users — rejected.

## Consequences

- Settings flag + conditional rendering in nav and Home.
- Data migration preserves monotributo access for all existing users.
- Amends ADR-053/054; future settings expansions should follow the same per-user flag pattern.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
