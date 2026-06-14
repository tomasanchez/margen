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

- **`npm audit fix --force` (upgrade Vitest 3 -> 4) *as the fix*)**: Relying on the Vitest bump alone would NOT clear the advisory, because the top-level Vite (the app's build tool) resolves esbuild independently of Vitest and would stay on 0.27.7 unless Vite also updates. The override fixes every consumer at once with a patch-level esbuild bump, so it is the necessary-and-sufficient mechanism regardless of the Vitest version — not chosen as the remediation. (Vitest was nonetheless upgraded to 4 separately for currency — see the update note below — and the override is still required.)
- **Leave the advisories (dev-only, not shipped)**: The dev-server file-read is a real risk on the Windows dev machine, and the team policy is to not merge issues that could snowball; clearing them now is cheap — not chosen.
- **Wait for Vite/Vitest to depend on patched esbuild**: Unbounded timeline; the override is reversible and removable later — not chosen.

## Consequences

`apps/web` carries an esbuild override until Vite (and any other esbuild consumer) natively depends on esbuild >=0.28.1, at which point the override should be removed and re-audited. esbuild 0.x bumps can carry breaking changes, so the override must be re-validated (build + test) whenever Vite/Vitest are upgraded. No production bundle impact (dev dependency only).

Relates to ADR-010 (CI runs build + tests on every `apps/web` change, providing a guardrail against regressions from future esbuild bumps) and ADR-018 (Vitest test suite — the passing tests are the verification signal that esbuild 0.28.1 is compatible with the toolchain).

## Update — 2026-06-13: Vitest upgraded to 4, override retained

Vitest was subsequently upgraded from 3.2.6 to **4.1.8** (for currency, not as the security fix). The override remains in place and remains necessary: Vitest 4 dropped its bundled nested Vite 7 + `vite-node` and now dedupes onto the top-level Vite 8.0.16, so the tree resolves a SINGLE esbuild — which is still `0.27.7` without the override. After the upgrade, `npm ls esbuild` shows `esbuild@0.28.1 (overridden)`, `npm audit` reports 0 vulnerabilities, and build + lint + the 32-test suite all pass. The MUI ESM `server.deps.inline` workaround in `vitest.config.ts` was verified still required under Vitest 4 and kept. This confirms the override — not the Vitest version — is the load-bearing remediation.

## Status History

- 2026-06-13: proposed
- 2026-06-13: accepted
- 2026-06-13: updated — Vitest upgraded 3 -> 4 for currency; override retained as the necessary remediation

> **Note (2026-06-13):** The esbuild pin stands. The override mechanism moved from npm `overrides` to `pnpm.overrides` when `apps/web` migrated to pnpm — see ADR-039.
