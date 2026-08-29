/**
 * TanStack Query hooks for Receivables ("money owed to me")
 * (ADR-204/206/208, ADR-036).
 *
 * Reads/mutates through {@link receivablesClient}. The domain has three reads —
 * the people list (each with a per-person `outstanding`), a single person's
 * detail (their itemized debts), and a person's ranked income-match suggestions
 * — plus write flows for people, items, and payments (manual + confirm-match).
 *
 * Invalidation follows the ADR-204 shape: a person's `outstanding` is derived
 * from their items and payments, so ANY item or payment write for a person
 * invalidates BOTH the people list (its `outstanding` column moved) AND that
 * person's detail (its items/remainders moved), plus that person's match
 * suggestions (a settled item changes what's still matchable). People-level
 * writes (create/rename/delete) invalidate the list and the affected person.
 *
 * Money stays a Decimal STRING through these hooks (ADR-025/034) — parsed only at
 * the display edge. Mutation hooks return TanStack Query's full result so callers
 * can surface `isError` / `error` (and catch {@link ReceivableOverpaymentError}
 * off `error`) for the calm failure + overpayment-confirm UX (ADR-037/206).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  receivablesClient,
  type MatchSuggestion,
  type Person,
  type PersonDetail,
  type PaymentAllocationInput,
  type ReceivablePayment,
  type ReceivableItem,
  type ReceivablePaymentSource,
} from '../../api/receivablesClient'

/** Stable query-key factory for the receivables domain. */
export const receivablesKeys = {
  all: ['receivables'] as const,
  people: () => [...receivablesKeys.all, 'people'] as const,
  person: (id: string) => [...receivablesKeys.all, 'person', id] as const,
  matchSuggestions: (id: string) =>
    [...receivablesKeys.all, 'person', id, 'match-suggestions'] as const,
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
 * Invalidate everything a per-person write can move: the people list (its
 * `outstanding` column), the affected person's detail, and that person's match
 * suggestions (a settled item changes what's still matchable). See the module note.
 */
function useInvalidatePerson() {
  const queryClient = useQueryClient()
  return (personId: string) => {
    void queryClient.invalidateQueries({ queryKey: receivablesKeys.people() })
    void queryClient.invalidateQueries({
      queryKey: receivablesKeys.person(personId),
    })
    void queryClient.invalidateQueries({
      queryKey: receivablesKeys.matchSuggestions(personId),
    })
  }
}

/** Create a person, then refresh the people list. */
export function useCreatePerson() {
  const queryClient = useQueryClient()
  return useMutation<PersonDetail, Error, string>({
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
    mutationFn: ({ id, name }) => receivablesClient.renamePerson(id, name),
    onSuccess: (_data, { id }) => invalidate(id),
  })
}

/** Delete a person (cascades items + payments), then refresh the list. */
export function useDeletePerson() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (id) => receivablesClient.deletePerson(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.people() })
      queryClient.removeQueries({ queryKey: receivablesKeys.person(id) })
    },
  })
}

/** Input for adding an itemized debt to a person. */
export interface AddItemInput {
  personId: string
  occurredOn: string
  amount: string
  detail?: string
}

/** Add an itemized debt, then refresh the list + that person's detail. */
export function useAddReceivableItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<ReceivableItem, Error, AddItemInput>({
    mutationFn: ({ personId, occurredOn, amount, detail }) =>
      receivablesClient.addItem(personId, { occurredOn, amount, detail }),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/** Input for editing an itemized debt (only supplied fields change, ADR-028). */
export interface EditItemInput {
  personId: string
  itemId: string
  occurredOn?: string
  amount?: string
  detail?: string
}

/** Edit an itemized debt, then refresh the list + that person's detail. */
export function useEditReceivableItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<ReceivableItem, Error, EditItemInput>({
    mutationFn: ({ personId, itemId, occurredOn, amount, detail }) =>
      receivablesClient.editItem(personId, itemId, {
        occurredOn,
        amount,
        detail,
      }),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/** Delete an itemized debt, then refresh the list + that person's detail. */
export function useDeleteReceivableItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<void, Error, { personId: string; itemId: string }>({
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.deleteItem(personId, itemId),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/**
 * Forgive an item (ADR-210), then refresh the list + that person's detail + their
 * match suggestions. Pardoning drops the item from the person's `outstanding` and
 * removes it as a payment/match target, so all three reads can move — reuse the
 * same person-wide invalidation as the other item writes.
 */
export function usePardonItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, { personId: string; itemId: string }>({
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.pardonItem(personId, itemId),
    onSuccess: (_data, { personId }) => invalidate(personId),
  })
}

/**
 * Un-forgive an item (ADR-210) — the inverse of {@link usePardonItem}. Restores
 * the item as owed (back in `outstanding` + eligible for payment/match), so the
 * same person-wide invalidation applies.
 */
export function useUnpardonItem() {
  const invalidate = useInvalidatePerson()
  return useMutation<PersonDetail, Error, { personId: string; itemId: string }>({
    mutationFn: ({ personId, itemId }) =>
      receivablesClient.unpardonItem(personId, itemId),
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
 * {@link ReceivableOverpaymentError} (catch it and retry with `allowOverpayment`).
 */
export function useRecordPayment() {
  const invalidate = useInvalidatePerson()
  return useMutation<ReceivablePayment, Error, RecordPaymentInput>({
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
  return useMutation<ReceivablePayment, Error, ConfirmMatchInput>({
    mutationFn: ({ personId, ...input }) =>
      receivablesClient.confirmMatch(personId, input),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: receivablesKeys.all }),
  })
}
