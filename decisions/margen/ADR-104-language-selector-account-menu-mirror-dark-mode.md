---
project: margen
adr: 104
title: Language selector in the account menu, mirroring the dark-mode control
category: ux
date: 2026-06-24
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-104: Language selector in the account menu, mirroring the dark-mode control

## Context

The user asked for a language selector in the account/user menu that behaves
like the existing dark-mode toggle.

## Decision

Add a **language selector** to `AccountMenu.tsx` beside the theme control,
presenting English / Español. It reflects and updates the active locale (via
the i18n context/hook from ADR-101), persists the choice, and is
keyboard-accessible with a clear label and non-color cues (ADR-019). On first
load with no stored choice, it reflects the browser-detected language.

## Alternatives Considered

- **Selector on the Settings page**: the request specifies the account menu,
  consistent with where dark mode lives — not chosen.

## Consequences

AccountMenu gains a language control; both the desktop Menu and mobile Drawer
variants must render it. The selector is the sole user-facing entry point for
changing locale at runtime.

Relates to: ADR-019 (accessibility conventions this control must follow),
ADR-101 (i18n hook/context the selector consumes and updates), ADR-100
(business decision that introduces the control).

## Status History

- 2026-06-24: accepted
