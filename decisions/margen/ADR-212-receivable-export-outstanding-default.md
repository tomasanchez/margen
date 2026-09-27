---
project: margen
adr: 212
title: "Receivable export defaults to outstanding-only; full history is opt-in"
category: ux
date: 2026-09-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-212: Receivable export defaults to outstanding-only; full history is opt-in

## Context

ADR-209/210/211 established the per-person receivable PDF ("Estado de cuenta") as a collection document the owner hands a debtor to justify what they owe. As built (ADR-211), the export always renders the FULL lifetime ledger: every non-pardoned charge and every payment as a running-balance list, plus the "Pagos recibidos" paid-history section. This grows without bound over time and reprints debts that are already fully settled ("cancelada" = paid off, es-AR) on every export — more than a "what you still owe" note needs to be.

## Decision

The export DEFAULTS to **outstanding only**: only items with a remaining balance > 0 (i.e. not cancelled/paid off) are shown, at their REMAINING amount, regardless of which month they were originally incurred — an old unpaid debt still appears, so the owner never under-collects. The hero balance block (Saldo pendiente), the 3-stat bar (total consumido / pagado / pendiente), and the "Lo pagué yo" covered/pardoned box (ADR-210) are retained in the default view. The payment rows (running-balance ledger) and the "Pagos recibidos" paid-history section are HIDDEN by default.

A **full-history opt-in** is added: an export option in the web UI backed by a `?full=` query param on the backend endpoint. When set, it restores the complete rendering as currently shipped by ADR-211 — full running-balance ledger (charges + payments) plus the paid-history section.

The owner explicitly considered and rejected hard-scoping the default to the current calendar month: a debt incurred in a prior month but still unpaid must keep appearing on the statement, since the goal is collection, not a monthly snapshot — the statement is simply dated the day it is sent. No month picker is introduced.

This is a refinement of ADR-211, not a reversal — it's the same template/design with two content modes (outstanding-only default, full-history opt-in). ADR-211 remains `accepted`; this ADR does not supersede it.

## Alternatives Considered

- **Keep full-history-always** (current ADR-211 behavior as the only mode): noisy, reprints already-settled debts, grows unbounded — rejected as the default, kept as an opt-in.
- **Strict current-month statement**: would hide older debts that are still unpaid, risking under-collection — rejected.
- **Outstanding + a highlighted "this month" section**: busier layout for v1; could be revisited later — rejected for now.
- **Month-picker UI**: adds extra UI surface; the outstanding-default + full-history-toggle pair covers the real need without it — deferred.

## Consequences

- The receivables view-model/template gains an outstanding-only mode: filter items to `remaining > 0`, render each at its remaining (not gross) amount, and omit payment rows and the paid-history section in that mode.
- The PDF export endpoint gains a `full` flag; default `false` (= outstanding-only). `full=true` reproduces today's ADR-211 rendering unchanged.
- The web export UI gains a "full history" affordance (e.g. a checkbox/toggle) to request `full=true`.
- Net worth remains unaffected — no change to `receivable_item` having no `account_id` (ADR-205).
- Relates to ADR-209 (PDF export origin), ADR-210 (covered/pardoned box, retained in both modes), ADR-211 (HTML/CSS + WeasyPrint rendering this ADR adds a content mode to — status-history note added there pointing here), ADR-206 (remaining/outstanding calculation this ADR filters and displays by).

## Status History

- 2026-09-27: accepted
