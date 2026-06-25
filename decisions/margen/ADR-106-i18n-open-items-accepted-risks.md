---
project: margen
adr: 106
title: i18n open items and accepted risks
category: risks
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-106: i18n open items and accepted risks

## Context

Whole-app translation has maintenance and coverage implications worth recording.

## Decision

Accept and track the following risks:

1. Every new UI string must be added to both `en` and `es` catalogs or it
   renders untranslated — mitigated by namespacing and optionally a
   key-completeness check in CI.
2. Unmapped backend category/bank/insight keys fall back to raw English (see
   ADR-103).
3. Only `en` and `es` are in scope — no RTL or other locales yet.
4. Pluralization relies on react-i18next built-ins (no ICU plugin) — revisit
   if complex grammar appears.
5. Spanish translation quality is owner-reviewed; no external review process is
   in place.

## Alternatives Considered

— (risk log; no alternatives apply)

## Consequences

These are logged as open items/risks; none block the feature. If a key-
completeness CI check is added later it should be recorded as a new ADR.

Relates to: ADR-100 (i18n business decision), ADR-101 (catalog structure where
missing keys surface), ADR-103 (unmapped backend key fallback risk listed
here).

## Status History

- 2026-06-24: accepted
