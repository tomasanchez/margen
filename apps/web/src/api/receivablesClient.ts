/**
 * Receivables ("money owed to me") API client + DTO boundary
 * (ADR-204, ADR-206, ADR-208).
 *
 * A receivable is an itemized debt a `person` owes the owner. Per ADR-204 the
 * model is four tables — person, item, payment, allocation — but the frontend
 * only ever speaks the read/write shapes the REST API (task 4) serializes:
 * `Person` (list, with a per-person `outstanding`), `PersonDetail` (a person +
 * their itemized debts, each carrying its own `allocated` / `remaining`), and
 * `MatchSuggestion` (a ranked income-transaction candidate for a confirm-match).
 * Receivables are ARS-only for v1 and carry NO `account_id` (structurally out of
 * net worth, ADR-205) — so there is no `currency` field to narrow here.
 *
 * Mirrors {@link debtsClient} / {@link accountsClient} (ADR-033): `apiUrl()` for
 * the versioned URL, `authedFetch` for the Supabase bearer token (ADR-092), a
 * `{ data }` envelope (ADR-030), and a status-carrying error on any non-2xx so
 * TanStack Query treats it as a failure and the view renders a calm error state
 * (ADR-037/130). Money stays a Decimal STRING end-to-end (ADR-025/034) — every
 * amount here is a string, parsed to a number only at the display edge (ADR-102).
 *
 * The one contract wrinkle (ADR-206): a payment or confirm-match that would push
 * a person's total allocated PAST their outstanding balance — WITHOUT an explicit
 * `allowOverpayment: true` — is rejected `409` with body
 * `{ "detail": { "code": "receivable_overpayment", "outstanding": "…",
 * "requested": "…" } }`. This client parses that shape into a typed, catchable
 * {@link ReceivableOverpaymentError} carrying `outstanding` / `requested` so the
 * UI (task 9) can show a confirm-warning and retry with `allowOverpayment: true`.
 * An over-ALLOCATED payment (allocations summing past the payment amount) is a
 * hard `422`; not-found / foreign ids are `404` — both surface as the base
 * {@link ReceivablesApiError} carrying the status.
 *
 * Installments + expense link (ADR-214…223): an item may carry a cuota schedule
 * (`installments`, empty for a flat item) and an optional REFERENCE-ONLY link to
 * the owner's expense it came from (`sourceTransaction`, never netted, ADR-219).
 * `outstanding` / `dueOutstanding` count only cuotas already due (ADR-215); the
 * not-yet-due remainder is reported apart as `upcomingTotal` (never negative; a
 * cuota paid beyond its amount is a CREDIT that lowers outstanding, which — like a
 * flat item's — can go negative). The typed conflicts parsed here:
 *  - `409 installment_schedule_locked` → {@link InstallmentScheduleLockedError}
 *    (re-shaping a plan that has payments or pardons, ADR-216);
 *  - `409 item_id_conflict` → {@link ReceivableItemIdConflictError} (a create
 *    retried with its idempotency `id` but different terms, ADR-204);
 *  - `409 allocation_exceeds_target` → {@link AllocationExceedsTargetError} (one
 *    item/cuota paid beyond what it owes — confirmable like an overpayment);
 *  - `422 installment_amount_below_paid` → {@link InstallmentAmountBelowPaidError}
 *    (a cuota edited below what was already paid toward it).
 * Dates are accepted only within 2000-01-01..2100-12-31 (else 422).
 */

import { apiUrl } from '../config'
import type { Currency } from '../mock/types'
import { authedFetch } from './http'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * A person in the list view (`GET /people`), newest-first. `outstanding` is what
 * the person owes TODAY — every flat item's remainder plus only the cuotas
 * already due (ADR-206/215) — kept as a Decimal STRING (ADR-025/034).
 * `upcomingTotal` is the not-yet-due cuota remainder: informational, never part
 * of `outstanding`.
 */
export interface Person {
  id: string
  name: string
  /** Server-managed creation timestamp (ISO datetime; drives newest-first order). */
  createdAt: string
  /** What the person owes today (due cuotas + flat items), as a Decimal string. */
  outstanding: string
  /** Not-yet-due cuotas, as a Decimal string (ADR-215) — never part of outstanding. */
  upcomingTotal: string
}

/** A cuota's state as of the request's "today" (ADR-215/221). */
export type InstallmentStatus = 'due' | 'upcoming' | 'paid' | 'pardoned'

/**
 * One cuota of an installment item (ADR-214). `paid` is Σ allocations targeting
 * it and `remaining` = `amount` − `paid` (all Decimal strings). A pardoned cuota
 * is forgiven (ADR-221): no longer owed and not payable, but kept on the plan.
 */
export interface ReceivableInstallment {
  id: string
  /** 1-based position in the plan. */
  index: number
  /** The date the cuota falls due (`YYYY-MM-DD`). */
  dueOn: string
  amount: string
  paid: string
  remaining: string
  pardoned: boolean
  status: InstallmentStatus
}

/**
 * The owner's expense a receivable item references (ADR-217) — also the shape of
 * an {@link ExpenseCandidate} offered by the link picker (ADR-220). `amount` is
 * the expense's ARS-equivalent magnitude; `usdAmount` the materialized USD value
 * (meaningful as "the original" only when `currency === 'USD'`).
 * `installmentsIndex` / `installmentsTotal` are the expense's OWN card-cuota
 * shape (ADR-174). `planTotal` is what the expense stands for in full — `amount` ×
 * `installmentsTotal` for a card cuota, else `amount` — and `linkedItemsTotal` is
 * Σ of every item (any person) already linking it: the non-blocking over-split
 * warning compares the second against the first (ADR-218).
 */
export interface SourceTransaction {
  id: string
  name: string
  occurredOn: string
  amount: string
  currency: Currency
  usdAmount: string | null
  installmentsIndex: number | null
  installmentsTotal: number | null
  planTotal: string
  linkedItemsTotal: string
}

/** One of the owner's expenses offered by the link picker (ADR-220). */
export type ExpenseCandidate = SourceTransaction

/** One suggested allocation slice — the same shape a payment allocation takes. */
export interface SuggestedAllocationLine {
  itemId: string
  /** The cuota the slice settles on an installment item, else null. */
  installmentId: string | null
  amount: string
}

/**
 * The server's default spread of a payment over what a person owes today
 * (ADR-221): due cuotas oldest-first, then open flat items newest-first; upcoming
 * cuotas are never suggested. Read-only — the client prefills its form with it.
 */
export interface SuggestedAllocation {
  /** The date due-ness was assessed on (`YYYY-MM-DD`). */
  asOf: string
  amount: string
  allocated: string
  /** What nothing currently due could absorb. */
  unallocated: string
  allocations: SuggestedAllocationLine[]
}

/** A cuota plan: `count` cuotas due monthly from `firstDueOn` (ADR-216). */
export interface InstallmentPlanInput {
  /** 2..120. */
  count: number
  /** The due date of cuota 1 (`YYYY-MM-DD`). */
  firstDueOn: string
}

/** A tweak to one cuota of a NEW plan (its even share / monthly date replaced). */
export interface InstallmentAdjustmentInput {
  /** 1-based cuota index, within 1..count and at most once per plan (422 otherwise). */
  index: number
  /** The cuota's amount instead of its even share, a positive Decimal string. */
  amount?: string
  /** The cuota's due date instead of the monthly one (`YYYY-MM-DD`). */
  dueOn?: string
}

/**
 * The cuota plan of an item being CREATED (ADR-216): the even split plus optional
 * per-cuota tweaks, applied in the same atomic write — the item amount is the
 * resulting cuotas' sum.
 */
export interface NewInstallmentPlanInput extends InstallmentPlanInput {
  cuotas?: InstallmentAdjustmentInput[]
}

/**
 * One itemized debt (`receivable_item`, ADR-204) as it appears inside a
 * {@link PersonDetail}. `allocated` is Σ of payments applied to this item and
 * `remaining` = `amount` − `allocated`; all three are Decimal strings. `detail`
 * is the free-text justification (null when the owner left it blank).
 *
 * `pardoned` (ADR-210) is true when the owner has FORGIVEN the item — covering it
 * out of pocket rather than collecting. A pardoned item is excluded server-side
 * from the person's `outstanding` and cannot receive payments/allocations; it
 * still surfaces here (with its historical `allocated` / `remaining`) so the UI
 * can render it as "covered by you". Pardon is a reversible toggle — un-pardon
 * clears the flag and restores the item as owed. This is DISTINCT from delete
 * (which removes an item entered in error entirely).
 */
export interface ReceivableItem {
  id: string
  /** The date the debt was incurred (`YYYY-MM-DD`). */
  occurredOn: string
  /** The original debt amount, as a Decimal string. */
  amount: string
  /** Free-text justification, or null when unset. */
  detail: string | null
  /** Amount settled so far (Σ allocations), as a Decimal string. */
  allocated: string
  /**
   * The GROSS remainder (`amount` − `allocated`) over all cuotas, due or not, as
   * a Decimal string. What is owed today is {@link ReceivableItem.dueOutstanding}.
   */
  remaining: string
  /**
   * True when the item has been forgiven (ADR-210). For an installment item:
   * every cuota is paid or pardoned and at least one is pardoned (ADR-221).
   */
  pardoned: boolean
  /** What the item contributes to outstanding today (ADR-215), a Decimal string. */
  dueOutstanding: string
  /** Not-yet-due cuota remainders (0 for a flat item), a Decimal string. */
  upcomingTotal: string
  /** The cuota schedule ordered by index; EMPTY for a flat item (ADR-214). */
  installments: ReceivableInstallment[]
  /** The expense this debt came from, or null (ADR-217). Reference only. */
  sourceTransaction: SourceTransaction | null
  /** True when the items linking the same expense add up to more than it (ADR-218). */
  linkedTotalExceedsExpense: boolean
}

/**
 * A person with their itemized debts (`GET /people/{id}`, and the body returned
 * by every person/item/payment write). `outstanding` is the person-level total
 * owed today; `items` are their receivable items (ADR-206/215).
 */
export interface PersonDetail {
  id: string
  name: string
  createdAt: string
  /** What the person owes today (Σ items' dueOutstanding), as a Decimal string. */
  outstanding: string
  /** Not-yet-due cuotas, as a Decimal string (ADR-215). */
  upcomingTotal: string
  items: ReceivableItem[]
}

/** The `POST /items` response: the person's detail plus the created item's id. */
export interface ItemCreatedDetail extends PersonDetail {
  /** The item this request created — or replayed, for an idempotent retry. */
  createdItemId: string
}

/**
 * A ranked income-transaction candidate for settling a person's debt
 * (`GET /people/{id}/match-suggestions`, ADR-207). `score` is the fuzzy-match
 * confidence (higher = better); `amount` is the income's Decimal-string amount.
 */
export interface MatchSuggestion {
  /** The candidate income transaction's id (used as `matchedIncomeTransactionId`). */
  transactionId: string
  /** The transaction's counterparty / description. */
  name: string
  /** The income amount, as a Decimal string. */
  amount: string
  /** The transaction date (`YYYY-MM-DD`). */
  occurredOn: string
  /** Fuzzy-match confidence score (higher ranks first). */
  score: number
}

/** How a payment was sourced (ADR-204/207). */
export type ReceivablePaymentSource = 'manual' | 'matched_income'

/**
 * One leg of a payment: applies `amount` (Decimal string) of the payment to a
 * single {@link ReceivableItem} (ADR-206) — or, for an installment item, to one
 * of its cuotas. `installmentId` is REQUIRED for an installment item and must be
 * omitted for a flat one (the API 422s otherwise, ADR-221/223).
 */
export interface PaymentAllocationInput {
  itemId: string
  /** The cuota this slice settles (installment items only). */
  installmentId?: string
  /** The portion of the payment applied, as a Decimal string. */
  amount: string
}

/** Request body for `POST /people` (create) — only a name (ADR-204/208). */
export interface PersonCreateBody {
  name: string
}

/** Request body for `PATCH /people/{id}` (rename). */
export interface PersonRenameBody {
  name: string
}

/**
 * Request body for `POST /people/{id}/items` (add an itemized debt). `detail` is
 * omitted when blank (never sent as null). Money is a Decimal string (ADR-025).
 * `installments` splits the amount into cuotas (ADR-216); `sourceTransactionId`
 * links the owner's expense it came from (ADR-217). Both are omitted when unset.
 */
export interface ItemCreateBody {
  /** Client-generated item id: a retry with the same id + terms never duplicates. */
  id?: string
  occurredOn: string
  amount: string
  detail?: string
  installments?: NewInstallmentPlanInput
  sourceTransactionId?: string
}

/** Raw input for {@link receivablesClient.addItem}. */
export interface ItemCreateInput {
  /**
   * Idempotency key: a client-generated UUID, generated ONCE per form and reused
   * on every retry, so a lost response can never create the item twice (ADR-204).
   */
  id?: string
  occurredOn: string
  amount: string
  detail?: string
  /** A cuota plan (with optional per-cuota tweaks), or null/omitted for a flat item. */
  installments?: NewInstallmentPlanInput | null
  /** The linked expense's id, or omitted for no link. */
  sourceTransactionId?: string | null
}

/**
 * Request body for `PATCH /people/{id}/items/{itemId}` (ADR-028): every field is
 * optional and an OMITTED field leaves the stored value unchanged.
 * `installments` and `sourceTransactionId` are TRI-STATE: omitted keeps the
 * current plan / link, `null` removes it, a value sets it (ADR-216/217).
 */
export interface ItemPatchBody {
  occurredOn?: string
  amount?: string
  detail?: string
  installments?: InstallmentPlanInput | null
  sourceTransactionId?: string | null
}

/**
 * Raw input for {@link receivablesClient.editItem}: `undefined` omits a field
 * (keep), `null` sends an explicit null (remove the plan / unlink).
 */
export type ItemPatchInput = ItemPatchBody

/**
 * Request body for `PATCH /people/{id}/items/{itemId}/installments/{index}` —
 * edit one cuota (e.g. interest or a recargo, ADR-216). Allowed after payments.
 */
export interface InstallmentPatchBody {
  amount?: string
  dueOn?: string
}

/** Query for `GET /expense-candidates` (ADR-220); every field is optional. */
export interface ExpenseCandidateQuery {
  /** Case-insensitive fragment of the expense name. */
  q?: string
  /** Earliest expense date (inclusive, `YYYY-MM-DD`). */
  from?: string
  /** Latest expense date (inclusive, `YYYY-MM-DD`). */
  to?: string
  /** Page size, 1..50 (server default 20). */
  limit?: number
}

/**
 * Request body for `POST /people/{id}/payments` — a manual payment allocated
 * across one or more items (ADR-206). Set `allowOverpayment: true` to proceed
 * past the person's outstanding on purpose (otherwise the API 409s — see
 * {@link ReceivableOverpaymentError}); omitted when false.
 */
export interface RecordPaymentBody {
  occurredOn: string
  amount: string
  source: ReceivablePaymentSource
  allocations: PaymentAllocationInput[]
  allowOverpayment?: boolean
}

/**
 * Request body for `POST /people/{id}/confirm-match` — settle from a matched
 * income transaction (ADR-207), allocated across items (ADR-206). Same
 * overpayment semantics as {@link RecordPaymentBody}.
 *
 * `occurredOn` (the matched income's date — the payback date) and `amount` (the
 * total settled, a Decimal string) are BOTH required by the API's
 * `ConfirmMatchRequest`; omitting them makes every confirm-match 422 (the bug
 * fixed here). `amount` must equal the sum of `allocations` — the same invariant
 * {@link RecordPaymentBody} enforces — so the overpayment/allocation contract
 * stays consistent between the manual and matched flows.
 */
export interface ConfirmMatchBody {
  occurredOn: string
  amount: string
  matchedIncomeTransactionId: string
  allocations: PaymentAllocationInput[]
  allowOverpayment?: boolean
}

/** An API error that carries the HTTP status so callers can branch on it. */
export class ReceivablesApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ReceivablesApiError'
    this.status = status
  }
}

/**
 * The typed `409` a payment/confirm-match raises when the total allocated would
 * exceed the person's outstanding and the caller did NOT pass
 * `allowOverpayment: true` (ADR-206). Carries the server-reported `outstanding`
 * and `requested` amounts (both Decimal strings) so the UI (task 9) can show a
 * confirm-warning ("this is X more than owed") and RETRY the same call with
 * `allowOverpayment: true`. Callers branch with `instanceof`:
 *
 * ```ts
 * try { await recordPayment(id, body) }
 * catch (e) {
 *   if (e instanceof ReceivableOverpaymentError) { // show warning, then retry
 *     await recordPayment(id, { ...body, allowOverpayment: true })
 *   } else throw e
 * }
 * ```
 */
export class ReceivableOverpaymentError extends ReceivablesApiError {
  /** The person's current outstanding balance, as a Decimal string. */
  readonly outstanding: string
  /** The total the rejected payment tried to allocate, as a Decimal string. */
  readonly requested: string

  constructor(outstanding: string, requested: string) {
    super(
      409,
      `Payment of ${requested} exceeds the outstanding balance of ${outstanding}. ` +
        'Pass allowOverpayment: true to record it anyway.',
    )
    this.name = 'ReceivableOverpaymentError'
    this.outstanding = outstanding
    this.requested = requested
  }
}

/** What pins a cuota plan so its shape can't change (ADR-216). */
export type ScheduleLockReason = 'allocations' | 'pardons'

/**
 * The typed `409` an item PATCH raises when it would RE-SHAPE a cuota plan (count,
 * first due date, total, or a flat ↔ installments conversion) while the item has
 * payments allocated (`reason: 'allocations'`) or forgiven cuotas
 * (`reason: 'pardons'`) — ADR-216. Terminal: the UI explains what to undo; per-cuota
 * edits stay allowed.
 */
export class InstallmentScheduleLockedError extends ReceivablesApiError {
  /** The item whose plan is locked. */
  readonly itemId: string
  /** What pins the plan. */
  readonly reason: ScheduleLockReason

  constructor(itemId: string, reason: ScheduleLockReason) {
    super(409, `The cuota plan of item ${itemId} is locked by ${reason}.`)
    this.name = 'InstallmentScheduleLockedError'
    this.itemId = itemId
    this.reason = reason
  }
}

/**
 * The typed `409` a create raises when its idempotency `id` is already used with
 * DIFFERENT terms (ADR-204) — e.g. a retry after the owner changed the form, or a
 * create whose first attempt did land. Terminal: the UI explains the item may
 * already exist rather than resubmitting.
 */
export class ReceivableItemIdConflictError extends ReceivablesApiError {
  readonly itemId: string

  constructor(itemId: string) {
    super(409, `Receivable item id ${itemId} is already used with different terms.`)
    this.name = 'ReceivableItemIdConflictError'
    this.itemId = itemId
  }
}

/**
 * The typed `409` a payment / confirm-match raises when ONE allocation pays an
 * item or cuota beyond what it still owes (ADR-206/221) — even when the person
 * owes enough overall. A confirm-time WARNING: retry with `allowOverpayment: true`
 * (which bypasses this and the person-level {@link ReceivableOverpaymentError})
 * to record the excess as a credit.
 */
export class AllocationExceedsTargetError extends ReceivablesApiError {
  readonly itemId: string
  /** The cuota paid beyond its remainder, or null for a flat item. */
  readonly installmentId: string | null
  /** What the item / cuota still owes, a Decimal string. */
  readonly remaining: string
  /** What the payment tried to apply to it, a Decimal string. */
  readonly requested: string

  constructor(
    itemId: string,
    installmentId: string | null,
    remaining: string,
    requested: string,
  ) {
    super(
      409,
      `Allocation of ${requested} exceeds the ${remaining} item ${itemId} still owes.`,
    )
    this.name = 'AllocationExceedsTargetError'
    this.itemId = itemId
    this.installmentId = installmentId
    this.remaining = remaining
    this.requested = requested
  }
}

/**
 * The typed `422` a cuota edit raises when its new amount is below what was
 * already paid toward it (ADR-216). Carries the minimum (`paid`) so the editor
 * can say "Can't be less than the ARS X already paid".
 */
export class InstallmentAmountBelowPaidError extends ReceivablesApiError {
  readonly itemId: string
  readonly index: number
  /** Already paid toward the cuota — the lowest amount allowed, a Decimal string. */
  readonly paid: string
  /** The rejected amount, a Decimal string. */
  readonly amount: string

  constructor(itemId: string, index: number, paid: string, amount: string) {
    super(422, `Cuota ${index} can't be ${amount}: ${paid} is already paid.`)
    this.name = 'InstallmentAmountBelowPaidError'
    this.itemId = itemId
    this.index = index
    this.paid = paid
    this.amount = amount
  }
}

/** A machine-readable FastAPI error `detail` (an object, not a message string). */
interface TypedDetail {
  code?: unknown
  outstanding?: unknown
  requested?: unknown
  itemId?: unknown
  installmentId?: unknown
  remaining?: unknown
  reason?: unknown
  index?: unknown
  paid?: unknown
  amount?: unknown
}

/** Parse a raw error body's `detail` OBJECT, or null (not JSON, or a plain message / list). */
function parseDetail(raw: string): TypedDetail | null {
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown } | null
    const detail = parsed && typeof parsed === 'object' ? parsed.detail : null
    return detail && typeof detail === 'object' && !Array.isArray(detail)
      ? (detail as TypedDetail)
      : null
  } catch {
    return null
  }
}

/** True for a string field. */
function isText(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * Parse a `409` / `422` body into its typed error, or null when the body is not
 * one of the documented shapes (ADR-204/206/216). Guards every field so a
 * malformed body degrades to the generic {@link ReceivablesApiError} rather than
 * throwing while building the error.
 */
function parseTypedError(status: number, raw: string): ReceivablesApiError | null {
  const detail = parseDetail(raw)
  if (!detail) return null
  if (status === 409) {
    if (
      detail.code === 'receivable_overpayment' &&
      isText(detail.outstanding) &&
      isText(detail.requested)
    ) {
      return new ReceivableOverpaymentError(detail.outstanding, detail.requested)
    }
    if (
      detail.code === 'allocation_exceeds_target' &&
      isText(detail.itemId) &&
      (detail.installmentId === null || isText(detail.installmentId)) &&
      isText(detail.remaining) &&
      isText(detail.requested)
    ) {
      return new AllocationExceedsTargetError(
        detail.itemId,
        detail.installmentId,
        detail.remaining,
        detail.requested,
      )
    }
    if (
      detail.code === 'installment_schedule_locked' &&
      isText(detail.itemId) &&
      (detail.reason === 'allocations' || detail.reason === 'pardons')
    ) {
      return new InstallmentScheduleLockedError(detail.itemId, detail.reason)
    }
    if (detail.code === 'item_id_conflict' && isText(detail.itemId)) {
      return new ReceivableItemIdConflictError(detail.itemId)
    }
  }
  if (
    status === 422 &&
    detail.code === 'installment_amount_below_paid' &&
    isText(detail.itemId) &&
    typeof detail.index === 'number' &&
    isText(detail.paid) &&
    isText(detail.amount)
  ) {
    return new InstallmentAmountBelowPaidError(
      detail.itemId,
      detail.index,
      detail.paid,
      detail.amount,
    )
  }
  return null
}

/**
 * Throw a typed error for any non-2xx response: the documented machine-readable
 * `409` / `422` bodies become their typed errors (see the module note); every
 * other non-2xx — including a validation `422` or a `404` — becomes a
 * status-carrying {@link ReceivablesApiError} so the calm error state can render
 * (ADR-037/130).
 */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    // Ignore body-read failures; the status alone drives the calm error state.
  }
  if (response.status === 409 || response.status === 422) {
    const typed = parseTypedError(response.status, raw)
    if (typed) throw typed
  }
  throw new ReceivablesApiError(
    response.status,
    `Receivables API request failed with ${response.status}${raw ? `: ${raw}` : ''}`,
  )
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const
const JSON_ACCEPT = { Accept: 'application/json' } as const
const PDF_CONTENT_TYPE = 'application/pdf'

/** True when a raw optional text field carries a non-blank value to send. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/** GET all people with their outstanding totals (owner-scoped, newest-first). */
async function listPeople(): Promise<Person[]> {
  const response = await authedFetch(apiUrl('/receivables/people'), {
    headers: JSON_ACCEPT,
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<Person[]>
  return envelope.data
}

/** GET one person + their itemized debts (each with allocated / remaining). */
async function getPerson(id: string): Promise<PersonDetail> {
  const response = await authedFetch(apiUrl(`/receivables/people/${id}`), {
    headers: JSON_ACCEPT,
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** POST a new person (201); returns the persisted person detail. */
async function createPerson(name: string): Promise<PersonDetail> {
  const body: PersonCreateBody = { name: name.trim() }
  const response = await authedFetch(apiUrl('/receivables/people'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** PATCH a person's name; returns the refreshed person detail. */
async function renamePerson(id: string, name: string): Promise<PersonDetail> {
  const body: PersonRenameBody = { name: name.trim() }
  const response = await authedFetch(apiUrl(`/receivables/people/${id}`), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** DELETE a person (204, no body); cascades their items + payments (ADR-204). */
async function deletePerson(id: string): Promise<void> {
  const response = await authedFetch(apiUrl(`/receivables/people/${id}`), {
    method: 'DELETE',
  })
  await ensureOk(response)
}

/**
 * Build a `POST /items` body from raw input: `detail` is dropped when blank
 * (never sent as null, ADR-187 convention), and an unset plan / link is omitted
 * (a flat, unlinked item). Money/date stay strings (ADR-025).
 */
function toItemCreateBody(input: ItemCreateInput): ItemCreateBody {
  const body: ItemCreateBody = {
    occurredOn: input.occurredOn,
    amount: input.amount,
  }
  if (input.id) body.id = input.id
  if (present(input.detail)) body.detail = input.detail.trim()
  if (input.installments) {
    const { count, firstDueOn, cuotas } = input.installments
    body.installments =
      cuotas && cuotas.length > 0
        ? { count, firstDueOn, cuotas }
        : { count, firstDueOn }
  }
  if (input.sourceTransactionId) {
    body.sourceTransactionId = input.sourceTransactionId
  }
  return body
}

/**
 * POST a new itemized debt — flat or split into cuotas (with any per-cuota tweaks
 * applied atomically), optionally linked to an expense — for a person (201).
 * Returns the person's refreshed detail plus `createdItemId`. With a
 * client-generated `id` the create is idempotent: a retry with the same id and
 * terms replays it; different terms reject with
 * {@link ReceivableItemIdConflictError}. 404 for an unknown person or link, 422
 * for an impossible plan or tweak (nothing is created).
 */
async function addItem(
  personId: string,
  input: ItemCreateInput,
): Promise<ItemCreatedDetail> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items`),
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(toItemCreateBody(input)),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<ItemCreatedDetail>
  return envelope.data
}

/**
 * PATCH an itemized debt (ADR-028): only the supplied fields change. `detail` is
 * sent only when non-blank; an omitted field leaves the stored value unchanged.
 * `installments` / `sourceTransactionId` are tri-state — `undefined` keeps the
 * current plan / link, `null` removes it, a value sets it (ADR-216/217).
 * Re-shaping a locked plan rejects with {@link InstallmentScheduleLockedError}.
 * Returns the person's refreshed detail.
 */
async function editItem(
  personId: string,
  itemId: string,
  input: ItemPatchInput,
): Promise<PersonDetail> {
  const body: ItemPatchBody = {}
  if (input.occurredOn !== undefined) body.occurredOn = input.occurredOn
  if (input.amount !== undefined) body.amount = input.amount
  if (present(input.detail)) body.detail = input.detail.trim()
  if (input.installments !== undefined) body.installments = input.installments
  if (input.sourceTransactionId !== undefined) {
    body.sourceTransactionId = input.sourceTransactionId
  }
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items/${itemId}`),
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/**
 * PATCH one cuota's amount and/or due date (ADR-216) — allowed even after
 * payments, but never below what was already paid toward it
 * ({@link InstallmentAmountBelowPaidError}); the item amount is re-derived as the
 * cuotas' sum. Returns the person's refreshed detail. 404 for an unknown
 * item/index, 422 for a zero amount.
 */
async function editInstallment(
  personId: string,
  itemId: string,
  index: number,
  input: InstallmentPatchBody,
): Promise<PersonDetail> {
  const body: InstallmentPatchBody = {}
  if (input.amount !== undefined) body.amount = input.amount
  if (input.dueOn !== undefined) body.dueOn = input.dueOn
  const response = await authedFetch(
    apiUrl(
      `/receivables/people/${personId}/items/${itemId}/installments/${index}`,
    ),
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** POST a cuota pardon toggle (`pardon` / `unpardon`, ADR-221). */
async function setInstallmentPardon(
  personId: string,
  itemId: string,
  index: number,
  action: 'pardon' | 'unpardon',
): Promise<PersonDetail> {
  const response = await authedFetch(
    apiUrl(
      `/receivables/people/${personId}/items/${itemId}/installments/${index}/${action}`,
    ),
    { method: 'POST', headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/**
 * FORGIVE a single cuota (ADR-221): it stops counting as owed and can't be paid,
 * but stays on the plan as "covered by you". Reversible via
 * {@link unpardonInstallment}. Returns the refreshed {@link PersonDetail}.
 */
async function pardonInstallment(
  personId: string,
  itemId: string,
  index: number,
): Promise<PersonDetail> {
  return setInstallmentPardon(personId, itemId, index, 'pardon')
}

/** Restore a forgiven cuota as owed (ADR-221) — the inverse of {@link pardonInstallment}. */
async function unpardonInstallment(
  personId: string,
  itemId: string,
  index: number,
): Promise<PersonDetail> {
  return setInstallmentPardon(personId, itemId, index, 'unpardon')
}

/**
 * GET the server's default allocation of `amount` (a Decimal string) over what a
 * person owes today (ADR-221): due cuotas oldest-first, then flat items
 * newest-first. Read-only — the payment forms prefill from it.
 */
async function suggestedAllocation(
  personId: string,
  amount: string,
): Promise<SuggestedAllocation> {
  const response = await authedFetch(
    apiUrl(
      `/receivables/people/${personId}/suggested-allocation?amount=${encodeURIComponent(amount)}`,
    ),
    { headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<SuggestedAllocation>
  return envelope.data
}

/**
 * GET the owner's expenses a receivable item may link to, newest first (ADR-220).
 * Blank params are omitted; already-linked expenses are included with their
 * `linkedItemsTotal` (one expense may back many items, ADR-218).
 */
async function searchExpenseCandidates(
  query: ExpenseCandidateQuery = {},
): Promise<ExpenseCandidate[]> {
  const params = new URLSearchParams()
  if (present(query.q)) params.set('q', query.q.trim())
  if (present(query.from)) params.set('from', query.from)
  if (present(query.to)) params.set('to', query.to)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  const response = await authedFetch(
    apiUrl(`/receivables/expense-candidates${search ? `?${search}` : ''}`),
    { headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<ExpenseCandidate[]>
  return envelope.data
}

/** DELETE an itemized debt (204, no body). */
async function deleteItem(personId: string, itemId: string): Promise<void> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items/${itemId}`),
    { method: 'DELETE' },
  )
  await ensureOk(response)
}

/**
 * POST to FORGIVE an item (ADR-210): the item stops counting toward the person's
 * outstanding and can no longer receive payments, but is preserved and shown as
 * "covered by you". Reversible via {@link unpardonItem}. Returns the refreshed
 * {@link PersonDetail} (its `outstanding` moved). 404 for a foreign/unknown id.
 */
async function pardonItem(
  personId: string,
  itemId: string,
): Promise<PersonDetail> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items/${itemId}/pardon`),
    { method: 'POST', headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/**
 * POST to UN-FORGIVE an item (ADR-210): clears the pardon so the item counts as
 * owed again and can once more receive payments. The inverse of
 * {@link pardonItem}. Returns the refreshed {@link PersonDetail}. 404 for a
 * foreign/unknown id.
 */
async function unpardonItem(
  personId: string,
  itemId: string,
): Promise<PersonDetail> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items/${itemId}/unpardon`),
    { method: 'POST', headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/**
 * POST a manual payment allocated across one or more items — or, for installment
 * items, cuotas (201, ADR-206/221). `allowOverpayment` is included only when true;
 * omitting it lets the API 409 with a typed {@link ReceivableOverpaymentError} the
 * caller can catch and retry (ADR-206). The threshold counts only cuotas already
 * due (ADR-215), so paying an upcoming cuota early also 409s. One allocation
 * paying an item / cuota beyond what it owes 409s as an
 * {@link AllocationExceedsTargetError}; `allowOverpayment: true` bypasses both.
 * Returns the person's refreshed detail.
 */
async function recordPayment(
  personId: string,
  input: {
    occurredOn: string
    amount: string
    source?: ReceivablePaymentSource
    allocations: PaymentAllocationInput[]
    allowOverpayment?: boolean
  },
): Promise<PersonDetail> {
  const body: RecordPaymentBody = {
    occurredOn: input.occurredOn,
    amount: input.amount,
    source: input.source ?? 'manual',
    allocations: input.allocations,
  }
  if (input.allowOverpayment) body.allowOverpayment = true
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/payments`),
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** GET ranked income-match suggestions for a person (ADR-207). */
async function matchSuggestions(personId: string): Promise<MatchSuggestion[]> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/match-suggestions`),
    { headers: JSON_ACCEPT },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<MatchSuggestion[]>
  return envelope.data
}

/**
 * POST a confirm-match: settle from a matched income transaction, allocated
 * across items / cuotas (201, ADR-206/207/221). Same overpayment semantics as
 * {@link recordPayment} — omit `allowOverpayment` to get the typed 409. Returns
 * the person's refreshed detail.
 */
async function confirmMatch(
  personId: string,
  input: {
    occurredOn: string
    amount: string
    matchedIncomeTransactionId: string
    allocations: PaymentAllocationInput[]
    allowOverpayment?: boolean
  },
): Promise<PersonDetail> {
  const body: ConfirmMatchBody = {
    occurredOn: input.occurredOn,
    amount: input.amount,
    matchedIncomeTransactionId: input.matchedIncomeTransactionId,
    allocations: input.allocations,
  }
  if (input.allowOverpayment) body.allowOverpayment = true
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/confirm-match`),
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<PersonDetail>
  return envelope.data
}

/** Turn a person name into a safe, human-readable PDF filename stem. */
function pdfFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    // Strip diacritics (García → garcia) so the slug stays ASCII-clean.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `receivables-${slug || 'person'}.pdf`
}

/**
 * Fetch a person's receivables PDF (`GET /people/{id}/pdf`) and trigger a browser
 * download (ADR-209). The endpoint is behind the Supabase bearer guard (ADR-092),
 * so a bare `<a href>` GET would 401 — we fetch the bytes through {@link authedFetch},
 * wrap them in a short-lived object URL, click a hidden `<a download>`, then revoke
 * the URL (mirrors {@link useReportDownload}). Throws {@link ReceivablesApiError}
 * on a non-2xx so the caller can surface a calm error (ADR-037).
 *
 * The PDF follows the app locale: the active UI language is sent as a `?lang=`
 * query param (`en` / `es`) so the backend renders the document in the same
 * language the user is viewing (the param name is reconciled with the API).
 *
 * Content mode (ADR-212): the default is OUTSTANDING-ONLY (only debts still owed,
 * at their remaining amount) and sends NO `full` param, keeping the URL clean.
 * Passing `full = true` opts into the FULL-HISTORY ledger + paid-history section
 * (the ADR-211 rendering) via `&full=true`.
 *
 * @param id   The person whose PDF to download.
 * @param name The person's display name, used to build the saved filename.
 * @param lang Optional UI language (`en` / `es`) to render the PDF in; when
 *             omitted the backend falls back to its own default.
 * @param full When true, request the full-history ledger (`full=true`); the
 *             default (false) requests the outstanding-only statement and omits
 *             the param entirely (ADR-212).
 */
async function downloadPersonPdf(
  id: string,
  name: string,
  lang?: string,
  full = false,
): Promise<void> {
  // Outstanding-only is the default and sends NO `full` param; `full=true` opts
  // into the complete ledger (ADR-212). The `?`/`&` joiner is chosen by whether
  // `lang` is already present so the query string stays valid in every case.
  let path = lang
    ? `/receivables/people/${id}/pdf?lang=${encodeURIComponent(lang)}`
    : `/receivables/people/${id}/pdf`
  if (full) {
    path += path.includes('?') ? '&full=true' : '?full=true'
  }
  const response = await authedFetch(apiUrl(path), {
    headers: { Accept: PDF_CONTENT_TYPE },
  })
  await ensureOk(response)
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = pdfFilename(name)
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // A saved file needs no lingering URL — release the bytes at once (ADR-165).
    URL.revokeObjectURL(objectUrl)
  }
}

/** The receivables API client, grouped for ergonomic import. */
export const receivablesClient = {
  listPeople,
  getPerson,
  createPerson,
  renamePerson,
  deletePerson,
  addItem,
  editItem,
  deleteItem,
  pardonItem,
  unpardonItem,
  editInstallment,
  pardonInstallment,
  unpardonInstallment,
  suggestedAllocation,
  searchExpenseCandidates,
  recordPayment,
  matchSuggestions,
  confirmMatch,
  downloadPersonPdf,
} as const

export { pdfFilename }
