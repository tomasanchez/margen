/**
 * TanStack Query hooks for the Budgets domain (ADR-125, ADR-036).
 *
 * Reads/mutates through {@link budgetsClient}, which adapts the backend budgets
 * contract to the frontend {@link BudgetPeriod}. The period read is month-keyed
 * (the `YYYY-MM` is part of the query key), so switching months in the navigator
 * refetches and re-renders the page (ADR-040/125).
 *
 * Setting or clearing a target invalidates the whole `budgets` key family AND
 * the Home `summaries` family — the budget read derives spend from the same
 * category summaries source (ADR-042/043), and the Home budget-progress card
 * reads budgets too, so both stay fresh after a write. Mutation hooks return
 * TanStack Query's full result so callers can surface `isError` / `error` for
 * the calm failure UX (ADR-037).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  budgetsClient,
  type ApplyProfileResult,
  type BudgetIncome,
  type BudgetIncomeWriteBody,
  type BudgetPeriod,
  type BudgetWriteBody,
  type RepriceBody,
  type SavingProfile,
} from '../../api/budgetsClient'
import { homeQueryKeys } from '../home/queries'
import type { Category } from '../../mock/types'

/** Stable query-key factory for the budgets domain. */
export const budgetsKeys = {
  all: ['budgets'] as const,
  /** Period read is per-month, so the `YYYY-MM` is part of the key. */
  period: (month: string) => [...budgetsKeys.all, 'period', month] as const,
  /** The net-income base + floor is per-month too (ADR-139). */
  income: (month: string) => [...budgetsKeys.all, 'income', month] as const,
}

/** Read the budgets period (every category + target/spent/remaining) for a month. */
export function useBudgets(month: string) {
  return useQuery<BudgetPeriod>({
    queryKey: budgetsKeys.period(month),
    queryFn: () => budgetsClient.fetchBudgets(month),
  })
}

/**
 * Read the PRIOR month's budgets period (for the reprice-rollover prompt,
 * ADR-137). Only enabled when a prior month is supplied; reuses the same
 * per-month cache key so it's shared with a direct view of that month.
 */
export function usePriorBudgets(priorMonth: string | null) {
  return useQuery<BudgetPeriod>({
    queryKey: budgetsKeys.period(priorMonth ?? '—'),
    queryFn: () => budgetsClient.fetchBudgets(priorMonth as string),
    enabled: priorMonth != null,
  })
}

/** Read the per-month net-income base + household floor (ADR-139). */
export function useBudgetIncome(month: string) {
  return useQuery<BudgetIncome>({
    queryKey: budgetsKeys.income(month),
    queryFn: () => budgetsClient.fetchBudgetIncome(month),
  })
}

/**
 * Invalidate every budgets query plus the Home summaries family after a write —
 * budgets derive spend from the summaries source (ADR-042/043) and the Home card
 * reads budgets, so both refresh.
 */
function useInvalidateBudgets() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: budgetsKeys.all })
    void queryClient.invalidateQueries({ queryKey: homeQueryKeys.all })
  }
}

/** Upsert a category's target for a month, then refresh budgets + Home. */
export function useSetBudgetTarget() {
  const invalidate = useInvalidateBudgets()
  return useMutation<void, Error, BudgetWriteBody>({
    mutationFn: (body) => budgetsClient.setTarget(body),
    onSuccess: invalidate,
  })
}

/** Clear a category's target for a month, then refresh budgets + Home. */
export function useClearBudgetTarget() {
  const invalidate = useInvalidateBudgets()
  return useMutation<void, Error, { category: Category; month: string }>({
    mutationFn: ({ category, month }) =>
      budgetsClient.clearTarget(category, month),
    onSuccess: invalidate,
  })
}

/**
 * Upsert the net-income base + optional manual floor for a month (ADR-139), then
 * refresh budgets + Home (saving rows + pressure/strategy derive from income).
 */
export function useSetBudgetIncome() {
  const invalidate = useInvalidateBudgets()
  return useMutation<void, Error, BudgetIncomeWriteBody>({
    mutationFn: (body) => budgetsClient.setBudgetIncome(body),
    onSuccess: invalidate,
  })
}

/**
 * Apply a saving profile for a month (ADR-138), then refresh budgets + Home. The
 * mutation result carries the floor-guard outcome (`floorBreached` + `gap`) so
 * the caller can surface the calm warning.
 */
export function useApplyProfile() {
  const invalidate = useInvalidateBudgets()
  return useMutation<
    ApplyProfileResult,
    Error,
    { month: string; profile: SavingProfile }
  >({
    mutationFn: ({ month, profile }) =>
      budgetsClient.applyProfile(month, profile),
    onSuccess: invalidate,
  })
}

/**
 * Reprice spend caps from one month into the next (ADR-137), then refresh
 * budgets + Home. Never auto-applies — the caller confirms in the preview modal.
 */
export function useReprice() {
  const invalidate = useInvalidateBudgets()
  return useMutation<BudgetPeriod, Error, RepriceBody>({
    mutationFn: (body) => budgetsClient.reprice(body),
    onSuccess: invalidate,
  })
}
