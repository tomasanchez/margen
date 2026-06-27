---
project: margen
adr: 121
title: Roadmap: quick-capture chat bot and image recognition (future, separate initiative)
category: business
date: 2026-06-27
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-121: Roadmap: quick-capture chat bot and image recognition (future, separate initiative)

## Context

The owner wants frictionless transaction capture: a WhatsApp or Telegram bot to add transactions quickly from a mobile device, and image recognition of transaction screenshots or photos (e.g., a photo of a receipt or a bank-app notification). These would be high-value UX additions but are architecturally distinct from the accounts/budgets foundation being built now.

## Decision

Record as a DESIRED FUTURE channel on the roadmap — its own initiative, not part of the PFM MVP. When scoped, it will require:

- Bot webhook integration (WhatsApp Business API or Telegram Bot API).
- A vision/OCR pipeline, likely a Claude vision model or equivalent.
- Image PII handling and data-retention policy (related concerns in ADR-073 and ADR-081).

A separate deep-plan session must be run before implementation begins.

## Alternatives Considered

- **Build now alongside accounts/budgets**: Rejected — the bot + vision pipeline is large, architecturally separate, and orthogonal to the PFM foundation. Building it concurrently would fragment delivery focus.

## Consequences

- Reserves the strategic direction without committing implementation capacity.
- Flags future infra requirements: bot tokens/webhooks, vision API credentials, image PII safety (see ADR-073, ADR-081 for related precedent on document handling).
- No code changes result from this ADR.

## Status History

- 2026-06-27: proposed
- 2026-06-27: accepted
