---
project: margen
adr: 59
title: "Settings MVP scope boundaries and accepted risks"
category: risks
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-059: Settings MVP scope boundaries and accepted risks

## Context

Issue #10 is a deliberately small settings slice (ADR-053). Several adjacent capabilities were raised during planning and explicitly deferred or accepted as known risks to keep the changeset shippable.

## Decision

### Deferred (out of MVP scope)

- **Per-category Monotributo threshold override**: the A–K scale is a maintained constant with a visible scale year (ADR-051/048); the indicator is surfaced but users cannot override individual ceilings in this issue. A future issue may add overrides.
- **Automatic AFIP scale updates**: the scale constant is manually maintained (ADR-051); no polling or AFIP API integration in MVP.
- **USD reformatting of transaction rows**: transaction rows carry per-row currencies; converting them to a single live rate would be misleading. Only Home cards and summaries convert (ADR-056).
- **USD display of Monotributo figures**: the ARS ceiling expressed in a live USD rate is volatile and confusing; deferred to a future issue.
- **Multi-user / per-user settings**: the single-row `app_settings` table (ADR-054) assumes a single user. Auth and household scoping are explicit non-goals for the current prototype.

### Accepted risks

- **Live dolarapi.com dependency for USD display**: when `preferred_display_currency = USD` and the rate fetch fails, the UI falls back to ARS with a calm note (ADR-037/056). No stored conversion; ARS remains authoritative. This is acceptable because the fallback is graceful and the dependency already exists (ADR-044).
- **FX default limited to MEP / official**: `manual` is a per-entry override on the Add/Edit flow (ADR-045), not a meaningful default — offering it as a default would confuse the UX. Accepted; manual remains an entry-level choice only.
- **Removing `PATCH /api/v1/monotributo/config` is safe**: the frontend is the only consumer of that endpoint and is updated in the same PR. No external consumers exist. Accepted; the change is atomic within the issue.
- **Manual-threshold staleness**: the AFIP A–K ceiling scale must be updated manually when AFIP revises it (ADR-051). The scale year is surfaced as a visible indicator so users know how current the data is. Accepted; the alternative (AFIP scraping) is out of scope.

## Alternatives Considered

- **Block on per-category overrides / AFIP sync before shipping**: both are future-issue work; blocking would indefinitely delay a functional settings surface — rejected.
- **Keep ARS-only display**: the acceptance criterion for issue #10 requires the currency preference to affect summaries where applicable; ARS-only would not satisfy it — rejected.

## Consequences

A focused, shippable settings slice with four real preferences that drive behavior. Explicit deferrals are recorded here and in the business ADR (ADR-053) so they appear in `decision-reader` searches and are not silently forgotten.

Future issues can build on this slice to add per-category overrides, AFIP sync, broader USD display across transaction rows and Monotributo figures, and multi-user auth scoping.

Related: ADR-051 (scale staleness risk, monotributo MVP scope), ADR-053 (business scope), ADR-054 (architecture — single-row store), ADR-056 (USD display), ADR-057 (UX wiring), ADR-058 (test coverage).

## Status History

- 2026-06-14: accepted
