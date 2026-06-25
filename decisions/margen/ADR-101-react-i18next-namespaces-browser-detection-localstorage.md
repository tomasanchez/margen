---
project: margen
adr: 101
title: Adopt react-i18next with per-feature namespaces, browser detection, localStorage persistence
category: architecture
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-101: Adopt react-i18next with per-feature namespaces, browser detection, localStorage persistence

## Context

Need an i18n library for React 19 + Vite 8 + MUI v9 with namespacing,
plural/interpolation, and browser-language detection. The app already persists
the dark-mode choice via a ColorModeProvider + localStorage pattern.

## Decision

Use **react-i18next** (+ **i18next-browser-languagedetector**). Organize
catalogs as per-feature namespaces (e.g. `common`, `shell`, `home`,
`transactions`, `monotributo`, `settings`, `insights`, `auth`) under a
`locales/` tree, mirroring `src/features/` (ADR-016). Initialize i18n in a
small bootstrap module imported once. Language precedence: stored choice
(localStorage) > `navigator.language` > `'en'`. Persist the choice to
localStorage, mirroring ColorModeProvider; expose it via a context/hook
consumed by the selector.

## Alternatives Considered

- **FormatJS/react-intl**: ICU verbosity unneeded — strings are mostly static
  labels; react-i18next is lighter for this scope — not chosen.
- **LinguI**: less common, adds build-time macros for little gain here — not
  chosen.
- **Tiny custom context**: reinvents detection/plurals/formatting;
  react-i18next is low-friction and standard — not chosen.

## Consequences

Adds `react-i18next` + `i18next-browser-languagedetector` deps. Introduces an
i18n bootstrap module and a provider/hook. Namespaced JSON catalogs per feature
for `en` and `es` must be maintained in lockstep.

Relates to: ADR-100 (business decision driving this choice), ADR-016 (feature
folder structure mirrored by catalog namespaces), ADR-102 (Intl formatting
built on the active locale exposed by this layer), ADR-104 (language selector
UX consuming this hook), ADR-105 (test strategy for this setup).

## Status History

- 2026-06-24: accepted
