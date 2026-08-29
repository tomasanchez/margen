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
 */

import { apiUrl } from '../config'
import { authedFetch } from './http'

/** The backend `{ data: T }` response envelope (ADR-030). */
interface ResponseEnvelope<T> {
  data: T
}

/**
 * A person in the list view (`GET /people`), newest-first. `outstanding` is the
 * sum of every item's remainder (`item.amount` − Σ its allocations, ADR-206),
 * kept as a Decimal STRING (ADR-025/034).
 */
export interface Person {
  id: string
  name: string
  /** Total still owed across all this person's items, as a Decimal string. */
  outstanding: string
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
  /** Amount still owed (`amount` − `allocated`), as a Decimal string. */
  remaining: string
  /** True when the item has been forgiven (ADR-210): excluded from outstanding. */
  pardoned: boolean
}

/**
 * A person with their itemized debts (`GET /people/{id}`, and the body returned
 * by create/rename). `outstanding` is the person-level total; `items` are their
 * receivable items, each with its own `allocated` / `remaining` (ADR-206).
 */
export interface PersonDetail {
  id: string
  name: string
  /** Person-level outstanding total (Σ item remainders), as a Decimal string. */
  outstanding: string
  items: ReceivableItem[]
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
 * single {@link ReceivableItem} (ADR-206). A payment carries one or more.
 */
export interface PaymentAllocationInput {
  itemId: string
  /** The portion of the payment applied to this item, as a Decimal string. */
  amount: string
}

/**
 * A recorded incoming payment (`receivable_payment`, ADR-204) as returned by
 * `POST /people/{id}/payments` and `POST /people/{id}/confirm-match` (201).
 */
export interface ReceivablePayment {
  id: string
  /** The payment date (`YYYY-MM-DD`). */
  occurredOn: string
  /** The payment amount, as a Decimal string. */
  amount: string
  source: ReceivablePaymentSource
  /** The matched income transaction id when `source === 'matched_income'`, else null. */
  matchedIncomeTransactionId: string | null
  allocations: PaymentAllocationInput[]
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
 */
export interface ItemCreateBody {
  occurredOn: string
  amount: string
  detail?: string
}

/**
 * Request body for `PATCH /people/{id}/items/{itemId}` (ADR-028): every field is
 * optional and an OMITTED field leaves the stored value unchanged.
 */
export interface ItemPatchBody {
  occurredOn?: string
  amount?: string
  detail?: string
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
 */
export interface ConfirmMatchBody {
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

/** The FastAPI error envelope for an overpayment 409 (`detail` is an object). */
interface OverpaymentDetail {
  detail?: {
    code?: string
    outstanding?: string
    requested?: string
  }
}

/**
 * Parse a `409` body into a {@link ReceivableOverpaymentError}, or null when the
 * body is not the documented overpayment shape (ADR-206). Guards every field so
 * a malformed body degrades to the generic {@link ReceivablesApiError} rather
 * than throwing while building the error.
 */
function parseOverpayment(raw: string): ReceivableOverpaymentError | null {
  let parsed: OverpaymentDetail
  try {
    parsed = JSON.parse(raw) as OverpaymentDetail
  } catch {
    return null
  }
  const detail = parsed.detail
  if (
    detail?.code === 'receivable_overpayment' &&
    typeof detail.outstanding === 'string' &&
    typeof detail.requested === 'string'
  ) {
    return new ReceivableOverpaymentError(detail.outstanding, detail.requested)
  }
  return null
}

/**
 * Throw a typed error for any non-2xx response. A `409` carrying the documented
 * `receivable_overpayment` body becomes a {@link ReceivableOverpaymentError}
 * (with `outstanding` / `requested`); every other non-2xx — including a hard
 * `422` over-allocation or a `404` — becomes a status-carrying
 * {@link ReceivablesApiError} so the calm error state can render (ADR-037/130).
 */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    // Ignore body-read failures; the status alone drives the calm error state.
  }
  if (response.status === 409) {
    const overpayment = parseOverpayment(raw)
    if (overpayment) throw overpayment
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
 * (never sent as null, ADR-187 convention). Money/date stay strings (ADR-025).
 */
function toItemCreateBody(input: {
  occurredOn: string
  amount: string
  detail?: string
}): ItemCreateBody {
  const body: ItemCreateBody = {
    occurredOn: input.occurredOn,
    amount: input.amount,
  }
  if (present(input.detail)) body.detail = input.detail.trim()
  return body
}

/** POST a new itemized debt for a person (201); returns the created item. */
async function addItem(
  personId: string,
  input: { occurredOn: string; amount: string; detail?: string },
): Promise<ReceivableItem> {
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items`),
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(toItemCreateBody(input)),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<ReceivableItem>
  return envelope.data
}

/**
 * PATCH an itemized debt (ADR-028): only the supplied fields change. `detail` is
 * sent only when non-blank; an omitted field leaves the stored value unchanged.
 */
async function editItem(
  personId: string,
  itemId: string,
  input: { occurredOn?: string; amount?: string; detail?: string },
): Promise<ReceivableItem> {
  const body: ItemPatchBody = {}
  if (input.occurredOn !== undefined) body.occurredOn = input.occurredOn
  if (input.amount !== undefined) body.amount = input.amount
  if (present(input.detail)) body.detail = input.detail.trim()
  const response = await authedFetch(
    apiUrl(`/receivables/people/${personId}/items/${itemId}`),
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
  )
  await ensureOk(response)
  const envelope = (await response.json()) as ResponseEnvelope<ReceivableItem>
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
 * POST a manual payment allocated across one or more items (201). `allowOverpayment`
 * is included only when true; omitting it lets the API 409 with a typed
 * {@link ReceivableOverpaymentError} the caller can catch and retry (ADR-206).
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
): Promise<ReceivablePayment> {
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
  const envelope = (await response.json()) as ResponseEnvelope<ReceivablePayment>
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
 * across items (201, ADR-206/207). Same overpayment semantics as
 * {@link recordPayment} — omit `allowOverpayment` to get the typed 409.
 */
async function confirmMatch(
  personId: string,
  input: {
    matchedIncomeTransactionId: string
    allocations: PaymentAllocationInput[]
    allowOverpayment?: boolean
  },
): Promise<ReceivablePayment> {
  const body: ConfirmMatchBody = {
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
  const envelope = (await response.json()) as ResponseEnvelope<ReceivablePayment>
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
 * @param id   The person whose PDF to download.
 * @param name The person's display name, used to build the saved filename.
 * @param lang Optional UI language (`en` / `es`) to render the PDF in; when
 *             omitted the backend falls back to its own default.
 */
async function downloadPersonPdf(
  id: string,
  name: string,
  lang?: string,
): Promise<void> {
  const path = lang
    ? `/receivables/people/${id}/pdf?lang=${encodeURIComponent(lang)}`
    : `/receivables/people/${id}/pdf`
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
  recordPayment,
  matchSuggestions,
  confirmMatch,
  downloadPersonPdf,
} as const

export { pdfFilename }
