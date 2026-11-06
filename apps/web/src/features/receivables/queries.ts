/**
 * TanStack Query hooks for Receivables ("money owed to me")
 * (ADR-204/206/208, ADR-214…221, ADR-036).
 *
 * Reads/mutates through {@link receivablesClient}. Reads: the people list (each
 * with `outstanding` owed today + `upcomingTotal`), a single person's detail
 * (their itemized debts, cuota schedules and expense links), a person's ranked
 * income-match suggestions, the server's suggested payment allocation, and the
 * expense candidates for the link picker. Writes: people, items (flat or in
 * cuotas, ADR-216), single cuotas (edit / pardon, ADR-221), and payments.
 *
 * Invalidation follows the ADR-204 shape: a person's `outstanding` is derived
 * from their items and payments, so ANY item or payment write for a person
 * invalidates BOTH the people list AND that person's detail (and everything
 * keyed under it: match suggestions, suggested allocations). An item save that
 * may touch an expense LINK invalidates the whole receivables tree instead — one
 * expense can be linked from several people's items, and each of those items
 * carries the shared over-split flag (ADR-218).
 *
 * Money stays a Decimal STRING through these hooks (ADR-025/034) — parsed only at
 * the display edge. Mutation hooks return TanStack Query's full result so callers
 * can surface `isError` / `error` (and catch the typed 409s off `error`) for the
 * calm failure + overpayment / plan-lock UX (ADR-037/206/216).
 *
 * Every write carries a `receivables`-prefixed mutation key and names the item it
 * touches in its variables (`itemId`), so {@link useIsItemMutating} can tell when
 * ANY write for an item is in flight and the list can hold that item's actions.
 */

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  receivablesClient,
  type ExpenseCandidate,
  type ExpenseCandidateQuery,
  type ItemCreatedDetail,
  type ItemCreateInput,
  type ItemPatchInput,
  type MatchSuggestion,
  type Person,
  type PersonDetail,
  type PaymentAllocationInput,
  type ReceivablePaymentSource,
  type SuggestedAllocation,
} from '../../api/receivablesClient'
import type { CuotaEdit } from './installments'

/** Stable query-key factory for the receivables domain. */
export const receivablesKeys = {
  all: ['receivables'] as const,
  people: () => [...receivablesKeys.all, 'people'] as const,
  person: (id: string) => [...receivablesKeys.all, 'person', id] as const,
  matchSuggestions: (id: string) =>
    [...receivablesKeys.all, 'person', id, 'match-suggestions'] as const,
  suggestedAllocation: (id: string, amount: string) =>
    [...receivablesKeys.all, 'person', id, 'suggested-allocation', amount] as const,
  expenseCandidates: (query: ExpenseCandidateQuery) =>
    [...receivablesKeys.all, 'expense-candidates', query] as const,
  /** Mutation keys: every receivables write is filed under `receivables`. */
  mutation: (name: string) => [...receivablesKeys.all, 'mutation', name] as const,
}

/**
 * True while ANY receivables write naming this item (`variables.itemId`) is in
 * flight — an item save, a cuota edit / pardon, an item pardon or delete. The
 * list disables every action on that item meanwhile, so two writes can never
 * race on the same plan (e.g. a cuota edit against a whole-plan pardon).
 */
export function useIsItemMutating(itemId: string): boolean {
  return (
    useIsMutating({
      mutationKey: receivablesKeys.all,
      predicate: (mutation) => {
        const variables = mutation.state.variables as
          | { itemId?: unknown }
          | undefined
        return variables?.itemId === itemId
      },
    }) > 0
  )
}

/** Read the owner-scoped people list with outstanding totals (newest-first). */
export function useReceivablePeople() {
  return useQuery<Person[]>({
    queryKey: receivablesKeys.people(),
    queryFn: () => receivablesClient.listPeople(),
  })
}

/**
 * Read one person's detail (their itemized debts + remainders). Only enabled
 * once an id is supplied, so it stays idle while no person is selected.
 */
export function useReceivablePerson(id: string | null | undefined) {
  return useQuery<PersonDetail>({
    queryKey: receivablesKeys.person(id ?? '—'),
    queryFn: () => receivablesClient.getPerson(id as string),
    enabled: id != null && id !== '',
  })
}

/**
 * Read a person's ranked income-match suggestions (ADR-207). Only enabled once
 * an id is supplied; suggestions are read-only, so they're never invalidated by
 * a rename but ARE invalidated when a payment settles part of the debt.
 */
export function useReceivableMatchSuggestions(id: string | null | undefined) {
  return useQuery<MatchSuggestion[]>({
    queryKey: receivablesKeys.matchSuggestions(id ?? '—'),
    queryFn: () => receivablesClient.matchSuggestions(id as string),
    enabled: id != null && id !== '',
  })
}

/**
 * Read the server's default allocation of `amount` (a positive Decimal string)
 * for a person (ADR-221) — the payment forms PREFILL their rows from it. Idle
 * while `amount` is null (nothing typed yet / invalid). Always fresh: due-ness
 * moves with the calendar and with every payment.
 */
export function useSuggestedAllocation(
  personId: string,
  amount: string | null,
) {
  return useQuery<SuggestedAllocation>({
    queryKey: receivablesKeys.suggestedAllocation(personId, amount ?? '—'),
    queryFn: () =>
      receivablesClient.suggestedAllocation(personId, amount as string),
    enabled: amount !== null,
    staleTime: 0,
  })
}

/**
 * Search the owner's expenses the link picker offers (ADR-220), newest first.
 * Idle while `query` is null (the picker is closed and nothing is typed).
 */
export function useExpenseCandidates(query: ExpenseCandidateQuery | null) {
  return useQuery<ExpenseCandidate[]>({
    queryKey: receivablesKeys.expenseCandidates(query ?? {}),
    queryFn: () => receivablesClient.searchExpenseCandidates(query ?? {}),
    enabled: query !== null,
    staleTime: 30_000,
  })
}

/**
 * Invalidate everything a per-person write can move: the people list (its
 * `outstanding` column) and the affected person's detail — which, by key
 * prefix, also covers their match suggestions and suggested allocations.
 */
function useInvalidatePerson() {
  const queryClient = useQueryClient()
  return (personId: string) => {
    void queryClient.invalidateQueries({ queryKey: receivablesKeys.people() })
    void queryClient.invalidateQueries({
      queryKey: receivablesKeys.person(personId),
    })
  }
}

/** Create a person, then refresh the people list. */
export function useCreatePerson() {
  const queryClient = useQueryClient()
  return useMutation<PersonDetail, Error, string>({
    mutationKey: receivablesKeys.mutation('create-person'),
    mutationFn: (name) => receivablesClient.createPerson(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.people() })
    },
  })
}

/** Rename a person, then refresh the list + that person's detail. */
export function useRenamePerson() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, { id: string; name: string }>({
    mutationKey: receivablesKeys.mutation('rename-person'),
    mutationFn: ({ id, name }) => receivablesClient.renamePerson(id, name),
    onSuccess: (_data, { id }) => invalidate(id),
  })
}

/** Delete a person (cascades items + payments), then refresh the list. */
export function useDeletePerson() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationKey: receivablesKeys.mutation('delete-person'),
    mutationFn: (id) => receivablesClient.deletePerson(id),
    onSuccess: (_data, id) => {
      // Their items may have linked expenses other people's items share (ADR-218).
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all })
      queryClient.removeQueries({ queryKey: receivablesKeys.person(id) })
    },
  })
}

/**
 * Save an itemized debt — CREATE for a person or EDIT an existing one (ADR-216).
 *
 * CREATE is ONE atomic, idempotent POST: the cuota plan carries the owner's
 * per-cuota tweaks from the live preview (`installments.cuotas`), and the body's
 * client-generated `id` makes a retry after a lost response replay the original
 * instead of duplicating it (ADR-204). EDIT is the item PATCH (when anything
 * about the item changed) followed by one cuota PATCH per tweaked cuota; every
 * one of those writes is idempotent, so a failed edit is simply retried.
 */
export type SaveItemInput =
  | {
      mode: 'create'
      personId: string
      /** Must carry the form's idempotency `id`. */
      body: ItemCreateInput & { id: string }
    }
  | {
      mode: 'edit'
      personId: string
      itemId: string
      /** The item PATCH; `null` when only cuota edits changed. */
      patch: ItemPatchInput | null
      cuotaEdits: CuotaEdit[]
    }

/** The outcome of {@link useSaveReceivableItem}. */
export interface SaveItemResult {
  /** The person's detail after the last write. */
  detail: PersonDetail | null
  /** The saved item's id (the created one, from `createdItemId`, on a create). */
  itemId: string
}

/** Run a {@link SaveItemInput}. Throws the first failing write's error. */
async function saveItem(input: SaveItemInput): Promise<SaveItemResult> {
  if (input.mode === 'create') {
    const created: ItemCreatedDetail = await receivablesClient.addItem(
      input.personId,
      input.body,
    )
    return { detail: created, itemId: created.createdItemId }
  }
  let detail = input.patch
    ? await receivablesClient.editItem(input.personId, input.itemId, input.patch)
    : null
  for (const edit of input.cuotaEdits) {
    detail = await receivablesClient.editInstallment(
      input.personId,
      input.itemId,
      edit.index,
      { amount: edit.amount, dueOn: edit.dueOn },
    )
  }
  return { detail, itemId: input.itemId }
}

/**
 * Create or edit an item (with its cuota tweaks), then refresh the WHOLE
 * receivables tree: the expense link's shared over-split flag can move on other
 * people's items too (ADR-218). Refreshes on success AND on error, since a
 * failed edit may still have applied its first write.
 */
export function useSaveReceivableItem() {
  const queryClient = useQueryClient()
  return useMutation<SaveItemResult, Error, SaveItemInput>({
    mutationKey: receivablesKeys.mutation('save-item'),
    mutationFn: saveItem,
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all }),
  })
}

/** Delete an itemized debt, then refresh the receivables tree (it may have been linked). */
export function useDeleteReceivableItem() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { personId: string; itemId: string }>({
    mutationKey: receivablesKeys.mutation('delete-item'),
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.deleteItem(personId, itemId),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all }),
  })
}

/**
 * Forgive an item (ADR-210) — on an installment item, its whole remaining plan
 * (ADR-221) — then refresh the list + that person's detail + their suggestions.
 */
export function usePardonItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, { personId: string; itemId: string }>({
    mutationKey: receivablesKeys.mutation('pardon-item'),
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.pardonItem(personId, itemId),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/**
 * Un-forgive an item (ADR-210) — the inverse of {@link usePardonItem}; on an
 * installment item every forgiven cuota is restored (ADR-221).
 */
export function useUnpardonItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, { personId: string; itemId: string }>({
    mutationKey: receivablesKeys.mutation('unpardon-item'),
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.unpardonItem(personId, itemId),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/** Identifies one cuota of an item, for the cuota-level writes (ADR-221). */
export interface CuotaTarget {
  personId: string
  itemId: string
  /** 1-based cuota index. */
  index: number
}

/**
 * Edit one cuota's amount and/or due date (ADR-216) — allowed even after
 * payments, never below what was paid toward it (a typed 422). The item amount is
 * re-derived server-side, and a linked expense's over-split flag may move, so the
 * whole tree refreshes (ADR-218).
 */
export function useEditInstallment() {
  const queryClient = useQueryClient()
  return useMutation<
    PersonDetail,
    Error,
    CuotaTarget & { amount?: string; dueOn?: string }
  >({
    mutationKey: receivablesKeys.mutation('edit-cuota'),
    mutationFn: ({ personId, itemId, index, amount, dueOn }) =>
      receivablesClient.editInstallment(personId, itemId, index, {
        amount,
        dueOn,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all }),
  })
}

/** Forgive a single cuota (ADR-221), then refresh that person. */
export function usePardonInstallment() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, CuotaTarget>({
    mutationKey: receivablesKeys.mutation('pardon-cuota'),
    mutationFn: ({ personId, itemId, index }) =>
      receivablesClient.pardonInstallment(personId, itemId, index),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/** Restore a forgiven cuota as owed (ADR-221), then refresh that person. */
export function useUnpardonInstallment() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, CuotaTarget>({
    mutationKey: receivablesKeys.mutation('unpardon-cuota'),
    mutationFn: ({ personId, itemId, index }) =>
      receivablesClient.unpardonInstallment(personId, itemId, index),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/**
 * Input for a manual payment. Omit `allowOverpayment` to get the typed
 * {@link ReceivableOverpaymentError} on a 409 (the UI warns, then retries with
 * `allowOverpayment: true`, ADR-206). `source` defaults to `'manual'`.
 */
export interface RecordPaymentInput {
  personId: string
  occurredOn: string
  amount: string
  source?: ReceivablePaymentSource
  allocations: PaymentAllocationInput[]
  allowOverpayment?: boolean
}

/**
 * Record a manual payment, then refresh the list + that person's detail + their
 * match suggestions. A 409 overpayment surfaces on the mutation's `error` as a
 * {@link ReceivableOverpaymentError} — or, for one item / cuota paid beyond what
 * it owes, an {@link AllocationExceedsTargetError} (catch either and retry with
 * `allowOverpayment`).
 */
export function useRecordPayment() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, RecordPaymentInput>({
    mutationKey: receivablesKeys.mutation('record-payment'),
    mutationFn: ({ personId, ...input }) =>
      receivablesClient.recordPayment(personId, input),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/**
 * Input for confirming an income match (ADR-207). Same overpayment semantics as
 * {@link RecordPaymentInput}.
 */
export interface ConfirmMatchInput {
  personId: string
  /** The matched income's date (payback date), required by the API (ADR-207). */
  occurredOn: string
  /** The total settled (= Σ allocations), a Decimal string, required by the API. */
  amount: string
  matchedIncomeTransactionId: string
  allocations: PaymentAllocationInput[]
  allowOverpayment?: boolean
}

/**
 * Confirm an income match (creates a payment + allocations), then refresh the
 * WHOLE receivables tree. A confirmed income becomes "claimed" (ADR-207), which
 * removes it as a suggestion for EVERY person (two people can match the same
 * income), so we invalidate `receivablesKeys.all` — not just this person's
 * suggestions — to drop the now-claimed income from any other person's list.
 * Same 409 overpayment surfacing as {@link useRecordPayment}.
 */
export function useConfirmMatch() {
  const queryClient = useQueryClient()
  return useMutation<PersonDetail, Error, ConfirmMatchInput>({
    mutationKey: receivablesKeys.mutation('confirm-match'),
    mutationFn: ({ personId, ...input }) =>
      receivablesClient.confirmMatch(personId, input),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all }),
  })
}
