# Transactions REST API contract

This is the documented field-mapping contract for the transaction CRUD surface
introduced in issue #3 (ADR-030, ADR-024). The **live, authoritative contract**
is the OpenAPI / Swagger UI at **`/docs`** (and the schema at `/openapi.json`);
this page records the prototype-mock → API field disposition so the frontend can
adopt the endpoints with minimal churn in #14.

## Endpoints

All paths are mounted under the versioned prefix `/api/v1`. Every response uses
the `ResponseModel[T]` envelope (`{ "data": ... }`); JSON fields use **camelCase
aliases matching the frontend mock** (`apps/web/src/mock/types.ts`).

| Method | Path | Description | Success |
|--------|------|-------------|---------|
| `GET` | `/api/v1/transactions` | List all, newest-first by `occurredOn` (then `createdAt`) | `200`, `data: TransactionResponse[]` |
| `POST` | `/api/v1/transactions` | Create; re-reads and returns the persisted entity | `201`, `data: TransactionResponse` |
| `GET` | `/api/v1/transactions/{id}` | Get one by UUID | `200`, `data: TransactionResponse` |
| `PATCH` | `/api/v1/transactions/{id}` | Partial update; returns the refreshed entity | `200`, `data: TransactionResponse` |
| `DELETE` | `/api/v1/transactions/{id}` | Hard delete (ADR-030) | `204`, no body |

### Planned extension (#14) — not implemented now

Filtering, sorting and pagination query params (`type`, `currency`, `category`,
`bank`, `date`, `search`) are documented as a forward-compatible extension point
(ADR-030). The UI filters client-side today and does not consume them yet. The
OpenAPI route descriptions repeat this note.

## Error → HTTP mapping

Lenient validation (ADR-031): only true invariant violations are rejected.

| Condition | HTTP | Source |
|-----------|------|--------|
| Unknown UUID on `GET`/`PATCH`/`DELETE` | `404 Not Found` | `TransactionNotFoundError` (PATCH/DELETE) or reader miss (GET) |
| Non-positive `amountNum` | `422 Unprocessable Entity` | Pydantic `gt=0` on the request body / `InvalidAmountError` |
| Unknown `kind` | `422` | Pydantic enum / `UnknownKindError` |
| Unknown `currency` | `422` | Pydantic enum / `UnknownCurrencyError` |
| Malformed body (wrong types, bad date) | `422` | Pydantic request validation |
| USD row without `rate` | accepted (`201`/`200`) | Lenient — stored as incomplete (ADR-031) |

## Field mapping — prototype mock → API

Disposition per ADR-024: **keep** (same meaning, possibly camelCase-aliased),
**rename** (different backend name, aliased back to the mock name at the JSON
boundary), **derive** (computed in the response, never stored), **reject** (the
durable contract corrects a prototype shortcut). The backend domain field is the
`snake_case` attribute on the aggregate / command (AGENTS.md).

### `Transaction` (response shape)

| Mock field | API JSON field | Backend field | Disposition | Notes |
|------------|----------------|---------------|-------------|-------|
| `id` (`number`) | `id` (UUID) | `id` | reject mock type | UUID v4, safe in URLs (ADR-026); mock's `int` id is corrected |
| `dispDate` (`string`) | `dispDate` | — | derive | Computed from `occurredOn` (e.g. `"Jun 12"`); not stored (ADR-026) |
| `month` (`MonthName`) | `month` | — | derive | Full month name from `occurredOn` (e.g. `"June"`); not stored (ADR-026) |
| — | `occurredOn` (ISO date) | `occurred_on` | add | Real calendar date — the source for `dispDate`/`month` (ADR-026) |
| `name` | `name` | `name` | keep | Required first-class display label on the durable model (ADR-024 KEEP) |
| — | `notes` | `notes` | add | Optional free-text note, distinct from `name` (ADR-024 ADD) |
| `category` | `category` | `category` | keep | Tolerant of unknown values (ADR-027) |
| `bank` (`Bank`) | `bank` | `payment_method` | rename | Backend stores a generic payment-method label; aliased to `bank` |
| `currency` | `currency` | `currency` | keep | `ARS` \| `USD` |
| `type` (`TxType`) | `type` | — (property) | derive | Derived from `kind` (ADR-027); never persisted |
| `kind` (`TxKind`) | `kind` | `kind` | keep | Persisted source of truth |
| `amountNum` | `amountNum` | `amount` | rename | Positive ARS-equivalent `Decimal` (ADR-025); aliased to `amountNum` |
| `usd` | `usd` | `usd_amount` | rename | Original USD amount for USD rows; aliased to `usd` |
| `rate` | `rate` | `fx_rate` | rename | MEP rate used for USD→ARS; aliased to `rate` |
| — | `fxRateType` | `fx_rate_type` | add | FX rate family (defaults `MEP` for USD rows) — FX block (ADR-029) |
| — | `fxRateAsOf` | `fx_rate_as_of` | add | When the rate was observed — FX block (ADR-029) |
| `recurring` | `recurring` | `recurring` | keep | |
| — | `countsTowardMonotributo` | `counts_toward_monotributo` | add | Income/invoice only; forced `false` for expense (ADR-031) |
| — | `createdAt` | `created_at` | add | Server-managed timestamp (ADR-026) |
| — | `updatedAt` | `updated_at` | add | Server-managed; bumped on PATCH (ADR-026) |

`name` (required) and `notes` (optional) are distinct fields in the response: the
former is the display label shown everywhere, the latter is the free-text note #3
adds (ADR-024).

### `NewTransactionInput` (POST body) and `TransactionPatch` (PATCH body)

Create accepts the same camelCase aliases; `occurredOn` and `kind` are required,
`amountNum` must be `> 0`, everything else is optional (lenient — ADR-031). The
mock's `month` override is ignored — `month`/`dispDate` are derived from
`occurredOn`. Patch makes every field optional; an omitted field leaves the
stored value unchanged (ADR-028).

| Mock input field | API JSON field | Backend command field | Disposition |
|------------------|----------------|------------------------|-------------|
| `dispDate` | `occurredOn` | `occurred_on` | reject string date — send a real ISO date (ADR-026) |
| `month` (override) | — | — | reject — derived from `occurredOn`, not an input |
| `name` | `name` | `name` | keep (required on create) |
| — | `notes` | `notes` | add (optional) |
| `category` | `category` | `category` | keep |
| `bank` | `bank` | `payment_method` | rename |
| `currency` | `currency` | `currency` | keep |
| `type` | — | — | reject — `type` is derived from `kind`, never an input (ADR-027) |
| `kind` | `kind` | `kind` | keep (required on create) |
| `amountNum` | `amountNum` | `amount` | rename (required, `> 0`) |
| `usd` | `usd` | `usd_amount` | rename |
| `rate` | `rate` | `fx_rate` | rename |
| `recurring` | `recurring` | `recurring` | keep |
| — | `countsTowardMonotributo` | `counts_toward_monotributo` | add (optional) |

> The prototype's `type` is **not** accepted on input: it is always derived from
> `kind` server-side (ADR-027), eliminating the mock's redundant `type`/`kind`
> pair.

## Name-bridge summary

These are the renames the frontend needs to know to swap the mock cleanly.
`name` is **not** a rename — it maps straight through (`name` ↔ `name`); `notes`
is the new optional field #3 adds:

| Frontend (mock & API JSON) | Backend domain |
|----------------------------|----------------|
| `amountNum` | `amount` |
| `usd` | `usd_amount` |
| `rate` | `fx_rate` |
| `bank` | `payment_method` |
