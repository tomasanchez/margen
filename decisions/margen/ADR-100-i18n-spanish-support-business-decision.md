---
project: margen
adr: 100
title: Add internationalization with Spanish support
category: business
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-100: Add internationalization with Spanish support

## Context

margen's UI is English-only. The owner wants Spanish support so the app is
usable in es, with the language chosen from the account menu and defaulting to
the browser's preferred language.

## Decision

Introduce i18n with two locales — English (existing) and Spanish (new) — and
translate the WHOLE app in this first pass (the app is bounded: home,
transactions, monotributo, settings, login, nav/shell). Language is a
CLIENT-SIDE preference (like dark mode), not a backend/account setting.

## Alternatives Considered

- **Infra + high-traffic subset first**: translate only the most-visited screens
  first — Owner chose full coverage; partial translation leaves awkward
  mixed-language screens in a small app.
- **Store language in backend app-settings**: persist the user's locale choice
  in the database — the request frames it "like dark mode", a device-local UI
  preference; no backend round-trip needed.

## Consequences

Every visible string is externalized; a complete Spanish UX ships. Ongoing
cost: new UI strings must be added to both catalogs.

Relates to: ADR-101 (library and catalog structure), ADR-102 (locale-aware
formatting), ADR-103 (backend-provided text), ADR-104 (language selector UX),
ADR-105 (test strategy), ADR-106 (risks).

## Status History

- 2026-06-24: accepted
