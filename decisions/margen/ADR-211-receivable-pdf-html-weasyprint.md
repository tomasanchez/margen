---
project: margen
adr: 211
title: "Receivable PDF rendered from HTML/CSS Jinja template via WeasyPrint (replacing hand-drawn PyMuPDF)"
category: architecture
date: 2026-08-29
status: accepted
supersedes: ADR-209
authors: [Tomas Sanchez]
---

# ADR-211: Receivable PDF rendered from HTML/CSS Jinja template via WeasyPrint (replacing hand-drawn PyMuPDF)

## Context

ADR-209 (amended several times for language, icons, pardon, paid-history, and owner-name) established the per-person receivable PDF, generated server-side by hand-drawing rects and text with PyMuPDF (`fitz`). The owner has since supplied a rich editorial statement design, "Estado de cuenta entre amigos": a red hero balance block, a 3-stat bar, a running-balance ledger, a "Lo pagué yo" covered box, a footer, the Archivo web font, and precise colors and letter-spacing/tracking. Reproducing CSS-grade layout by hand-drawing primitives in PyMuPDF is fragile, low-fidelity (no real font/tracking control, painful coordinate math), and slow to iterate on every time the design changes. Rendering the actual HTML/CSS the design was authored in is far more faithful and maintainable.

## Decision

Generate the receivable PDF by rendering a **Jinja2** HTML/CSS template with **WeasyPrint** (HTML to PDF), replacing the hand-drawn PyMuPDF renderer. The Archivo font (SIL OFL) is embedded via `@font-face` from bundled TTFs. WeasyPrint is chosen over headless-Chromium/Playwright because it is far lighter (no ~300MB browser, no per-render browser process) while giving ample fidelity for a static statement document; the API already builds via Docker on Render, so WeasyPrint's system libraries (pango, cairo, harfbuzz, gdk-pixbuf) are added to the image.

This decision **supersedes ADR-209's generation mechanism** (server-side PyMuPDF hand-drawing) and its visual design for the receivables PDF specifically. **PyMuPDF/`fitz` remains the statement-parsing dependency** (ADR-069/076) — only the receivables PDF *generation* moves to WeasyPrint; parsing is untouched.

All data/content decisions accumulated across ADR-209's amendments and ADR-210 carry over unchanged into the new template: bilingual es-AR/en-US rendering (follows the active `?lang`/i18n locale, not a fixed English), owner name used instead of "you" in the covered section, outstanding items + covered/pardoned items + paid-history (payments received) sections, no em-dashes or en-dashes, ARS amount denomination, and net-worth isolation (ADR-205).

## Alternatives Considered

- **Keep hand-drawn PyMuPDF**: cannot faithfully reproduce the supplied CSS design; requires painful manual coordinate math and offers no real font/letter-spacing control — rejected.
- **Playwright / headless Chromium**: would be pixel-perfect against the HTML/CSS, but requires bundling a ~300MB Chromium binary, a heavier Docker image and memory footprint, and a browser process per render — overkill for rendering a static document — rejected.
- **reportlab / fpdf hand-layout**: same fidelity problem as PyMuPDF (manual primitive-based layout, no CSS) — rejected.

## Consequences

- New dependencies: `weasyprint` + `jinja2`.
- The API Dockerfile and CI Linux runner gain WeasyPrint's native system libraries (pango, cairo, harfbuzz, gdk-pixbuf).
- A bundled Archivo TTF asset is added to the repo for `@font-face` embedding.
- Local dev on Windows needs WeasyPrint's native libs to render the PDF locally — a known friction, mitigated by keeping the data/view-model and template-to-HTML layers pure and platform-independent, with the HTML-to-PDF call as the only native-dependent step.
- The visual design changes to the supplied "Estado de cuenta" layout: a running-balance ledger replaces the plain outstanding item list, alongside the hero balance block and 3-stat bar.
- Relates to ADR-069/076 (PyMuPDF/`fitz` remains the parsing dependency — unaffected by this change), ADR-204/206/208/209/210 (receivables data model, settlement, UI entry point, and the PDF's prior content/amendment history — all data/content decisions retained here).

## Status History

- 2026-08-29: accepted
