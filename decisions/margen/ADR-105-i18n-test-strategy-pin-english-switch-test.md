---
project: margen
adr: 105
title: i18n test strategy: pin English by default, add a switch test
category: testing
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-105: i18n test strategy: pin English by default, add a switch test

## Context

Existing Vitest/Testing-Library tests assert on visible English text;
introducing i18n could break those queries. The 100%-style frontend suite must
stay green.

## Decision

Pin the **default test locale to English** so existing visible-text assertions
keep passing with minimal churn (initialize i18n with `lng: 'en'` and resources
synchronously in the test setup). Add focused tests that verify (a) the language
selector switches the UI to Spanish, and (b) browser-language detection picks
`es` when `navigator.language` is Spanish.

## Alternatives Considered

- **Assert via translation keys**: rewrites many existing assertions for little
  benefit — not chosen.
- **Test both languages broadly**: largest rewrite; the switch + detection tests
  give sufficient coverage — not chosen.

## Consequences

Test setup initializes i18n synchronously in English; a small number of new
i18n-specific tests are added alongside the existing suite. Existing tests
require no text-query changes.

Relates to: ADR-101 (i18n bootstrap whose test initialization this mirrors),
ADR-100 (i18n business scope that necessitates this strategy).

## Status History

- 2026-06-24: accepted
