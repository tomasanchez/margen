# Deprecation / Rename Map — 2026-06-23

Pruning pass run before adding Supabase + Auth ADRs. The margen decision log
was found clean: no contradictions among `status: accepted` ADRs, no legacy
filenames (all conform to `ADR-NNN-slug.md`).

## Moved to `_deprecated/`

| ADR | Reason | Superseded by |
|-----|--------|---------------|
| `ADR-048-monotributo-config-table-afip-scale-constants.md` | Already `status: superseded` in its own frontmatter; was still living in the active folder. | ADR-054 (app-settings single-row table) and ADR-067 (versioned effective-dated monotributo scale registry) |

## Renames

None — all filenames were already conformant.

## Notes

- **ADR-079** left in place (`status: accepted`). ADR-089 only *partially*
  amends it (the `occurred_on` line-date mapping row); ADR-079 remains the
  living reference for all other statement-line field mappings, and the
  amendment is self-documented inline in ADR-079's body.
