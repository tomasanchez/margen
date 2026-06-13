---
project: margen
adr: 022
title: Remediate esbuild advisories via npm override pin
category: security
date: 2026-06-13
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-022: Remediate esbuild advisories via npm override pin

## Context

`npm audit` reported 5 high-severity advisories in `apps/web`, all rooted in esbuild <=0.28.0: a dev-server arbitrary-file-read on Windows (GHSA-g7r4-m6w7-qqqr) and a Deno binary-integrity issue (GHSA-gv7w-rqvm-qjhr). esbuild is a transitive DEV dependency via Vite and Vitest; it is not part of the production bundle, so end users have no runtime exposure — but the dev-server file-read is a real risk on the Windows development machine. Both the top-level Vite (8.0.16) and Vitest 3.x's nested Vite resolved esbuild to the vulnerable 0.27.7. The patched release is esbuild 0.28.1. `npm audit fix --force` proposed a breaking upgrade of Vitest 3 -> 4.

## Decision

Add an npm `overrides` pin `"esbuild": "^0.28.1"` in `apps/web/package.json`, forcing the patched esbuild 0.28.1 across the entire dependency tree (both the top-level Vite and Vitest's nested Vite/vite-node). This clears all 5 advisories at the root without a breaking Vitest 3->4 major upgrade. Verified after applying: esbuild resolves to 0.28.1 everywhere, `npm audit` reports 0 vulnerabilities, and `npm run build`, `npm run lint`, and the full Vitest suite (32 tests) all pass — confirming esbuild 0.28.1 is compatible with the installed Vite 8 / Vitest 3.

## Alternatives Considered

- **`npm audit fix --force` (upgrade Vitest 3 -> 4)**: A breaking major bump of the test runner that risks the config and the 32 passing tests, and would still leave the top-level Vite's esbuild on 0.27.7 unless Vite also updates — the override fixes every consumer at once with a patch-level esbuild bump — not chosen.
- **Leave the advisories (dev-only, not shipped)**: The dev-server file-read is a real risk on the Windows dev machine, and the team policy is to not merge issues that could snowball; clearing them now is cheap — not chosen.
- **Wait for Vite/Vitest to depend on patched esbuild**: Unbounded timeline; the override is reversible and removable later — not chosen.

## Consequences

`apps/web` carries an esbuild override until Vite and Vitest natively depend on esbuild >=0.28.1, at which point the override should be removed and re-audited. esbuild 0.x bumps can carry breaking changes, so the override must be re-validated (build + test) whenever Vite/Vitest are upgraded. No production bundle impact (dev dependency only).

Relates to ADR-010 (CI runs build + tests on every `apps/web` change, providing a guardrail against regressions from future esbuild bumps) and ADR-018 (Vitest test suite — the 32 passing tests were the verification signal that esbuild 0.28.1 is compatible with the Vitest 3 configuration).

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
