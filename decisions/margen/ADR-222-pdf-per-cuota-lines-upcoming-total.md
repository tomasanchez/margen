---
project: margen
adr: 222
title: "PDF Estado de cuenta renders one line per due, unpaid cuota, plus an upcoming-cuotas total (amends ADR-211/212)"
category: ux
date: 2026-11-06
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-222: PDF Estado de cuenta renders one line per due, unpaid cuota, plus an upcoming-cuotas total (amends ADR-211/212)

## Context

ADR-211/212 render the per-person "Estado de cuenta" PDF as a list of items (outstanding-only default, full-history opt-in via `?full=true`). Installment items (ADR-214) need different handling: the recipient should see exactly which cuota is due now, not an opaque lump item amount, while still being informed of what's coming later without it being counted as currently collectible (ADR-215).

## Decision

An installment item renders as **one line per due, unpaid cuota** (e.g. "Cuota 3/6") instead of a single item line. In outstanding-only mode (ADR-212 default), only due, unpaid cuotas are listed — at the same remaining-amount-per-line convention used for non-installment items — plus a separate informational **"upcoming cuotas"** total (future, not-yet-due cuotas) shown alongside the hero balance; it does not add into the collectible Saldo pendiente, consistent with ADR-215's outstanding formula. In full mode (`?full=true`), all cuotas render with their individual status (paid / pending / upcoming / pardoned). Language and formatting rules carry over unchanged from ADR-211: es-AR/en-US per the active locale, no em-dashes or en-dashes.

## Alternatives Considered

- **One line per item with a "(3/6)" annotation showing the item's full remaining total**: conflates the currently-due cuota with not-yet-due future cuotas and overstates what's collectible right now — rejected.
- **Omit the upcoming-cuotas total entirely**: simpler, but the owner wants the recipient to see what's coming for planning purposes even though it isn't yet owed — rejected.

## Consequences

- The PDF view-model needs a per-cuota row builder (distinct from the existing per-item row builder) and an upcoming-cuotas aggregate.
- Outstanding-only mode's existing `remaining > 0` filter (ADR-212) is applied at the cuota level, not the item level, for installment items.
- Amends ADR-211 (template/rendering) and ADR-212 (outstanding-only content mode) for installment items specifically; non-installment item rendering is unchanged.
- Relates to ADR-214 (schema), ADR-215 (outstanding/upcoming split mirrored here), ADR-221 (per-cuota allocation/pardon status rendered here).

## Status History

- 2026-11-06: accepted
