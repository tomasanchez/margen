---
project: margen
adr: 119
title: Reposition Margen as a broad personal-finance tool (Excel replacement)
category: business
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-119: Reposition Margen as a broad personal-finance tool (Excel replacement)

## Context

Margen began as a monotributo tracker built on top of a general transaction ledger. The owner wants it to replace a personal-finance spreadsheet for a broad audience — not just AR freelancers. The codebase is already largely a general ledger: transactions, categories, FX, recurring, insights, and PDF statement imports are all domain-agnostic. The "margin" in the name maps naturally to "what's left / headroom", which works for any user.

## Decision

Reposition Margen as a general PFM ("personal-finance manager") targeting a broad audience that wants to replace their Excel. The name "Margen" is kept. Monotributo is demoted to an optional module (see ADR-126). MVP build sequencing:

1. Accounts + net worth
2. Budgets
3. Reports + export
4. Cash-flow forecast

## Alternatives Considered

- **AR-freelancer-focused niche**: Keep monotributo at the center, market only to Argentine autonomos — rejected; the owner explicitly chose the broad PFM direction.
- **Stay monotributo-first**: Leave the product as-is and deepen monotributo features — rejected; the general ledger foundation already supports a broader scope and the repositioning is the stated goal.

## Consequences

- New modules are required: accounts/net worth (ADR-122), budgets (ADR-125), reports/export (ADR-129), cash-flow forecasting (ADR-130).
- Monotributo is feature-gated behind a settings toggle (ADR-126).
- Nav/IA must be reshaped (ADR-127).
- Margen enters a crowded PFM space; the differentiator is AR-currency-native handling + the monotributo niche hook (ADR-120).

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
