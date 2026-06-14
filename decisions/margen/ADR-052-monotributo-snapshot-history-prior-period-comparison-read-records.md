---
project: margen
adr: 52
title: "Monotributo periodic snapshot history, prior-trailing-12-month comparison, and read-records capture (Rocketry rejected)"
category: architecture
date: 2026-06-14
status: accepted
supersedes: null
authors: [Tomas Sanchez]
---

# ADR-052: Monotributo periodic snapshot history, prior-trailing-12-month comparison, and read-records capture (Rocketry rejected)

## Context

During Issue #8 planning the user asked to keep a HISTORY of Monotributo standings so the UI can compare the current period against the previous one (a toggle on the Monotributo page). This required settling three questions in-scope for PR #8:

1. **Storage model** — how to persist historical standings.
2. **Comparison window** — what "previous" means relative to "current".
3. **Capture strategy** — how and when the snapshot is written without an in-process scheduler.

A periodic computed snapshot approach was chosen over an effective-dated category log, and a prior-trailing-12-month comparison window was chosen (the window ending 12 months ago). A scheduler was discussed: Rocketry was proposed but depends on Pydantic v1 and is unmaintained, conflicting with this backend's Pydantic v2. Any in-process scheduler (Rocketry / APScheduler / AioClock) also duplicates runs across replicas and dies with the pod.

This decision revises the data model (ADR-048), the read endpoint (ADR-046 / ADR-047), and the frontend wiring (ADR-049).

## Decision

**Data model — `monotributo_snapshot` table.** Add a new history table with one row per evaluated trailing-12-month period, keyed by `period_end` month (unique):

| Column | Type | Notes |
|---|---|---|
| `period_start` | date | Start of the trailing window |
| `period_end` | date | End of the trailing window (unique key, month-granular) |
| `category` | text | Category in effect at capture time |
| `activity_type` | text | `services` or `bienes` |
| `limit` | NUMERIC | Annual ceiling at capture time |
| `used` | NUMERIC | Sum of included invoices over the window |
| `remaining` | NUMERIC | `limit − used` at capture time |
| `percent_used` | NUMERIC | `used / limit × 100` at capture time |
| `status` | text | Status band key (`safe` / `watch` / `close` / `over`) |
| `projected_category` | text | Projected category at capture time |
| `captured_at` | timestamptz | Wall-clock time of the snapshot write |

**Revised GET endpoint shape.** `GET /api/v1/monotributo` now returns:

```json
{
  "current":  { /* live trailing-12-month standing */ },
  "previous": { /* prior trailing-12-month window */ },
  "scale":    [ /* A–K ceilings */ ],
  "invoices": [ /* included invoice list */ ]
}
```

- `current` — live trailing-12-month standing computed from transactions using the configured category (ADR-046); unchanged logic.
- `previous` — the prior trailing-12-month window (ending 12 months ago): read from the persisted snapshot when one exists for that month; otherwise computed live as a fallback.

**Read-records capture.** The GET handler computes the current standing via the read-only reader, then triggers an explicit command/handler that idempotently UPSERTS the snapshot for the current `period_end` month. On first read, missing monthly snapshots are BACKFILLED from existing transactions so the comparison has data immediately without waiting for a scheduler.

**External capture endpoint.** A thin authenticated `POST /api/v1/monotributo/capture` is exposed so an external scheduler (k8s CronJob / Azure scheduled job / GitHub Actions schedule) can trigger capture at ARCA's semi-annual recategorization cadence. Wiring this scheduler is a separate devops follow-up issue — no in-process scheduling code ships in this PR.

**Separation of concerns.** The reader stays read-only. The snapshot write is a command on the Unit of Work. The ARCA scale (ceilings) auto-ingestion remains out of scope (ADR-051) — the scale stays a versioned constant.

## Alternatives Considered

- **Rocketry in-process scheduler**: depends on Pydantic v1 (this backend is Pydantic v2) and is unmaintained — hard dependency conflict; rejected outright.
- **APScheduler / AioClock in-process**: Pydantic-v2 safe but still duplicates runs across replicas and dies with the pod; read-records + external cron is more robust.
- **Effective-dated category log instead of computed snapshots**: user chose persisted computed standings so historical figures (limit / used / status) are frozen with the category that applied at the time, not recomputed against today's scale.
- **Backfill-only, no capture on read**: history would grow only on explicit events; read-records keeps the current period fresh with no scheduler dependency.

## Consequences

- Snapshot history self-populates (backfill + read-records) so the prior-period comparison works immediately with no scheduler dependency and no replica-duplication problem.
- The GET endpoint performs an explicit idempotent write (a "read that records") — documented and keyed by `period_end` month so concurrent reads in the same month converge to the same row.
- A thin `POST capture` endpoint + a devops follow-up issue cover the scheduled ARCA-cadence trigger without in-process scheduling.
- Adds a `monotributo_snapshot` table and an Alembic migration alongside the `monotributo_config` table from ADR-048.
- Frozen historical snapshots may diverge from a later recompute if the scale constant is updated — this is acceptable and intended: they record what was true at capture time.
- Frontend (ADR-049) gains a "Compare to previous period" toggle; see ADR-049 note.

## Status History

- 2026-06-14: accepted
