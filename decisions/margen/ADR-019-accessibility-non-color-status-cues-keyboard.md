---
project: margen
adr: 019
title: Accessibility: non-color status cues and keyboard support
category: ux
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-019: Accessibility: non-color status cues and keyboard support

## Context

The concept leans on color for Safe/Watch/Risk and for income/expense amounts; color alone is insufficient for accessibility.

## Decision

Always pair status color with a text label and/or icon (Safe/Watch/Risk); ensure interactive controls (tabs, chips, menus, FAB) are keyboard-operable; Dialog and Drawer trap focus and restore it on close; amounts carry accessible labels (e.g. sign and currency announced). Aim for sufficient contrast in both palettes.

## Alternatives Considered

- **Visual parity with the concept only**: Color-only status and weak keyboard support exclude users and undercut the "clear" product intent — not chosen.

## Consequences

Slightly more markup (labels/icons/ARIA) but a usable, inclusive prototype. Sets an a11y baseline for product work. Complements ADR-013's dual-palette theme by requiring contrast checks on both modes.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
