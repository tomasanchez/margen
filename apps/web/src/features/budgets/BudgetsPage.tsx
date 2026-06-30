/**
 * Budgets — the zero-based "assign every peso a job" surface (ADR-145, ADR-146,
 * ADR-147, ADR-040, ADR-037).
 *
 * The page is one coherent allocation surface over the existing endpoints (no
 * data-model change). For the selected month (the page owns its OWN month via
 * the shared `MonthSwitcher`, defaulting to the current month, ADR-040):
 *
 *  - a SPENDABLE-INCOME HERO pairs the net-income input ({@link NetIncomeHeader})
 *    with a stacked Needs / Wants / Savings allocation bar + a live "left to
 *    assign / over-assigned / all assigned" readout ({@link AllocationBar}) and a
 *    row of {@link QuickStartTemplates} chips;
 *  - a THIS-MONTH-VS-PLAN band ({@link PlanBand}) headlines budgeted/spent/
 *    remaining with a plain-language insight line;
 *  - three CATEGORY GROUP CARDS — Needs + Wants ({@link GroupCard}) and the
 *    existing Savings profiles ({@link SavingsSection}) — hold the editable rows.
 *
 * Server state comes from TanStack Query (budgets, income, history). Editing is
 * calm: a row commits on blur/Enter and the page upserts (PUT) / clears (DELETE),
 * then budgets + Home invalidate. Quick-start templates batch the same per-
 * category writes once (ADR-147). The reprice rollover prompt + the month
 * navigator are unchanged (ADR-137/040). A GET failure shows the calm error
 * state; pending shows skeletons. Money is derived in `derive.ts` and formatted
 * via the shared es-AR helpers (ADR-102).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { SectionCard } from '../../components/SectionCard'
import { ErrorState } from '../../components/ErrorState'
import { MonthSwitcher } from '../../components/MonthSwitcher'
import {
  addMonths,
  currentViewingMonth,
  formatViewingMonth,
  type ViewingMonth,
} from '../../components/months'
import { toYearMonth } from '../home/queries'
import { NetIncomeHeader } from './NetIncomeHeader'
import { AllocationBar } from './AllocationBar'
import { QuickStartTemplates, type TemplateId } from './QuickStartTemplates'
import { PlanBand } from './PlanBand'
import { GroupCard } from './GroupCard'
import { SavingsSection } from './SavingsSection'
import { RepricePrompt } from './RepricePrompt'
import {
  categoryGroup,
  deriveAllocationSegments,
  deriveBudgetTotals,
  deriveClearAllTargets,
  deriveFiftyThirtyTwentyTargets,
  deriveGroupAllocation,
  deriveLeftToAssign,
  deriveMatchAvgTargets,
  deriveMatchLastMonthTargets,
  derivePlanInsight,
  isRepriceRollover,
  PROFILE_SAVINGS_PCT,
} from './derive'
import {
  useApplyProfile,
  useApplyTemplate,
  useBudgetHistory,
  useBudgetIncome,
  useBudgets,
  useClearBudgetTarget,
  usePriorBudgets,
  useReprice,
  useSetBudgetIncome,
  useSetBudgetTarget,
} from './queries'
import { budgetsClient, type SavingProfile } from '../../api/budgetsClient'
import type { Category } from '../../mock/types'

export function BudgetsPage() {
  const { t } = useTranslation('budgets')
  // The Budgets page owns its OWN month selection (the global navigator drives
  // Home only, ADR-040), defaulting to the current real calendar month.
  const [month, setMonth] = useState<ViewingMonth>(() => currentViewingMonth())
  const yearMonth = toYearMonth(month)
  const monthLabel = formatViewingMonth(month)
  const priorMonthValue = addMonths(month, -1)
  const priorYearMonth = toYearMonth(priorMonthValue)
  const priorLabel = formatViewingMonth(priorMonthValue)

  const budgetsQuery = useBudgets(yearMonth)
  const incomeQuery = useBudgetIncome(yearMonth)
  const historyQuery = useBudgetHistory(yearMonth)
  const priorQuery = usePriorBudgets(priorYearMonth)
  const setTarget = useSetBudgetTarget()
  const clearTarget = useClearBudgetTarget()
  const setIncome = useSetBudgetIncome()
  const applyProfile = useApplyProfile()
  const applyTemplate = useApplyTemplate()
  const reprice = useReprice()

  // Track which category's write is in flight / errored so the spinner + retry
  // hint show only on the affected row (ADR-037). Cleared on the next attempt.
  const [savingCategory, setSavingCategory] = useState<Category | null>(null)
  const [errorCategory, setErrorCategory] = useState<Category | null>(null)

  // The applied profile + the floor-guard result from the last apply (ADR-138).
  const [appliedProfile, setAppliedProfile] = useState<SavingProfile | null>(null)
  const [applyingProfile, setApplyingProfile] = useState<SavingProfile | null>(null)
  const [floorBreached, setFloorBreached] = useState(false)
  const [floorGap, setFloorGap] = useState<string | null>(null)

  // The pulled variable-income suggestion (lazy; null until requested).
  const [suggestedBase, setSuggestedBase] = useState<string | null>(null)
  const [suggestedBaseEmpty, setSuggestedBaseEmpty] = useState(false)

  // Which quick-start template is applying, for the calm pending state (ADR-147).
  const [applyingTemplate, setApplyingTemplate] = useState<TemplateId | null>(null)

  const period = budgetsQuery.data
  const income = incomeQuery.data
  const history = useMemo(() => historyQuery.data ?? [], [historyQuery.data])
  const currency = period?.currency ?? income?.currency ?? 'ARS'

  const totals = useMemo(
    () => (period ? deriveBudgetTotals(period) : undefined),
    [period],
  )
  const allocation = useMemo(
    () => (period ? deriveGroupAllocation(period) : undefined),
    [period],
  )
  const segments = useMemo(
    () =>
      allocation
        ? deriveAllocationSegments(income?.amount ?? null, allocation)
        : undefined,
    [allocation, income?.amount],
  )
  const left = useMemo(
    () =>
      allocation
        ? deriveLeftToAssign(income?.amount ?? null, allocation)
        : undefined,
    [allocation, income?.amount],
  )
  const insight = useMemo(
    () => (period ? derivePlanInsight(period) : undefined),
    [period],
  )

  // Split categories into the Needs / Wants groups (Savings is its own section).
  const needsLines = useMemo(
    () => (period ? period.categories.filter((c) => categoryGroup(c) === 'needs') : []),
    [period],
  )
  const wantsLines = useMemo(
    () => (period ? period.categories.filter((c) => categoryGroup(c) === 'wants') : []),
    [period],
  )

  // category → 3-month average (Decimal string) for the per-row "use avg" chips.
  const avgByCategory = useMemo(
    () => new Map(history.map((line) => [line.category, line.avg3mo] as const)),
    [history],
  )

  // Reprice rollover: the current month has no spend targets while the prior one
  // does (ADR-137). Never auto-applies — surfaces a prompt only.
  const showReprice = useMemo(
    () => isRepriceRollover(period, priorQuery.data),
    [period, priorQuery.data],
  )

  const handleCommitIncome = (amount: string) =>
    setIncome.mutate({ month: yearMonth, amount })

  const handleCommitFloor = (amount: string) => {
    if (income?.amount == null) return
    setIncome.mutate({
      month: yearMonth,
      amount: income.amount,
      floorAmount: amount,
      floorSource: 'manual',
    })
  }

  const handleUseSuggested = () => {
    void budgetsClient.fetchSuggestedBase(yearMonth).then((base) => {
      if (base == null) {
        setSuggestedBaseEmpty(true)
        return
      }
      setSuggestedBase(base)
      setSuggestedBaseEmpty(false)
      setIncome.mutate({ month: yearMonth, amount: base })
    })
  }

  const handleApplyProfile = (profile: SavingProfile) => {
    setApplyingProfile(profile)
    applyProfile.mutate(
      { month: yearMonth, profile },
      {
        onSuccess: (result) => {
          setAppliedProfile(profile)
          setFloorBreached(result.floorBreached)
          setFloorGap(result.gap)
        },
        onSettled: () => setApplyingProfile(null),
      },
    )
  }

  const handleApplyTemplate = (template: TemplateId) => {
    if (!period) return
    setApplyingTemplate(template)
    let targets: Partial<Record<Category, string | null>>
    let profile: SavingProfile | undefined
    switch (template) {
      case '503020':
        targets = deriveFiftyThirtyTwentyTargets(period, history, income?.amount ?? null)
        // The 20% Savings leg of 50/30/20 is the Conservative preset (ADR-147/138).
        profile = 'conservative'
        break
      case 'avg':
        targets = deriveMatchAvgTargets(period, history)
        break
      case 'lastMonth':
        targets = deriveMatchLastMonthTargets(period, history)
        break
      case 'clear':
      default:
        targets = deriveClearAllTargets(period)
        break
    }
    applyTemplate.mutate(
      { month: yearMonth, targets, profile },
      {
        onSuccess: () => {
          if (profile != null) setAppliedProfile(profile)
        },
        onSettled: () => setApplyingTemplate(null),
      },
    )
  }

  const handleReprice = (
    monthlyInflation: number,
    stepUps: Record<string, string>,
  ) =>
    reprice.mutate({
      fromMonth: priorYearMonth,
      toMonth: yearMonth,
      monthlyInflation,
      stepUps,
    })

  // Best-effort selected profile: the to-savings % nearest the current rows.
  const selectedProfile = useMemo<SavingProfile | null>(() => {
    if (appliedProfile != null) return appliedProfile
    if (!period || period.savings.length === 0) return null
    const total = period.savings
      .filter((s) => s.bucket !== 'MaintenanceReserve')
      .reduce((sum, s) => sum + s.percent, 0)
    const match = (Object.keys(PROFILE_SAVINGS_PCT) as SavingProfile[]).find(
      (p) => PROFILE_SAVINGS_PCT[p] === total,
    )
    return match ?? null
  }, [appliedProfile, period])

  const handleCommit = (category: Category, amount: string) => {
    setSavingCategory(category)
    setErrorCategory(null)
    setTarget.mutate(
      { category, month: yearMonth, amount },
      {
        onSettled: () => setSavingCategory(null),
        onError: () => setErrorCategory(category),
      },
    )
  }

  const handleClear = (category: Category) => {
    setSavingCategory(category)
    setErrorCategory(null)
    clearTarget.mutate(
      { category, month: yearMonth },
      {
        onSettled: () => setSavingCategory(null),
        onError: () => setErrorCategory(category),
      },
    )
  }

  const heading = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 2,
        mb: 2.5,
      }}
    >
      <Box>
        <Typography
          component="h1"
          sx={{ fontSize: { xs: '1.25rem', md: '1.375rem' }, fontWeight: 600 }}
          color="text.primary"
        >
          {t('title')}
        </Typography>
        <Typography sx={{ fontSize: 13.5, mt: 0.25 }} color="text.secondary">
          {t('subtitle')}
        </Typography>
      </Box>
      <MonthSwitcher variant="stepper" value={month} onChange={setMonth} />
    </Box>
  )

  if (budgetsQuery.isError) {
    return (
      <Box>
        {heading}
        <ErrorState
          title={t('error.title')}
          description={t('error.description')}
          onRetry={() => void budgetsQuery.refetch()}
        />
      </Box>
    )
  }

  const loading = budgetsQuery.isPending || !period || !totals || !allocation || !segments || !left || !insight
  const hasIncome = income?.amount != null
  const templatesDisabled = !hasIncome || !period || period.categories.length === 0

  return (
    <Box>
      {heading}

      {showReprice && priorQuery.data ? (
        <RepricePrompt
          prior={priorQuery.data}
          priorLabel={priorLabel}
          toMonth={yearMonth}
          toLabel={monthLabel}
          currency={currency}
          applying={reprice.isPending}
          applyError={reprice.isError}
          onConfirm={handleReprice}
        />
      ) : null}

      {/* SPENDABLE-INCOME HERO: income input + allocation bar + templates. */}
      <Box sx={{ mb: 2.5 }}>
        <NetIncomeHeader
          income={income}
          monthLabel={monthLabel}
          currency={currency}
          pressure={period?.pressure ?? null}
          suggestedStrategy={period?.suggestedStrategy ?? null}
          saving={setIncome.isPending}
          saveError={setIncome.isError}
          suggestedBase={suggestedBase}
          suggestedBaseEmpty={suggestedBaseEmpty}
          onCommitIncome={handleCommitIncome}
          onCommitFloor={handleCommitFloor}
          onUseSuggested={handleUseSuggested}
        />
      </Box>

      <Box sx={{ mb: 2.5 }}>
        <SectionCard title={t('alloc.cardTitle')} subtitle={t('alloc.cardSubtitle')}>
          {loading ? (
            <Skeleton variant="rounded" height={22} sx={{ borderRadius: '8px' }} />
          ) : (
            <>
              <AllocationBar
                allocation={allocation}
                segments={segments}
                left={left}
                incomeAmount={income?.amount ?? null}
                currency={currency}
              />
              <Box sx={{ mt: 2.5 }}>
                <QuickStartTemplates
                  applying={applyingTemplate}
                  disabled={templatesDisabled}
                  onApply={handleApplyTemplate}
                />
              </Box>
            </>
          )}
        </SectionCard>
      </Box>

      {/* THIS MONTH VS PLAN band. */}
      {loading ? (
        <SectionCard title={t('plan.title')} subtitle={t('plan.subtitle')}>
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="rounded" height={10} sx={{ mt: 1.5, borderRadius: '6px' }} />
        </SectionCard>
      ) : (
        <PlanBand totals={totals} insight={insight} currency={currency} />
      )}

      {/* CATEGORY GROUP CARDS: Needs, Wants, Savings. */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 2.5 }}>
        {loading ? (
          <SectionCard title={t('list.title')} subtitle={t('list.subtitle')}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Box key={i} sx={{ py: 1.5 }}>
                <Skeleton variant="text" width="40%" />
                <Skeleton variant="rounded" height={8} sx={{ mt: 1, borderRadius: '5px' }} />
              </Box>
            ))}
          </SectionCard>
        ) : period.categories.length === 0 ? (
          <SectionCard title={t('list.title')} subtitle={t('list.subtitle')}>
            <Typography sx={{ fontSize: 14, py: 2 }} color="text.secondary" role="status">
              {t('list.empty')}
            </Typography>
          </SectionCard>
        ) : (
          <>
            <GroupCard
              group="needs"
              lines={needsLines}
              avgByCategory={avgByCategory}
              groupTotal={allocation.needs}
              incomeAmount={income?.amount ?? null}
              currency={currency}
              savingCategory={savingCategory}
              errorCategory={errorCategory}
              onCommit={handleCommit}
              onClear={handleClear}
            />
            <GroupCard
              group="wants"
              lines={wantsLines}
              avgByCategory={avgByCategory}
              groupTotal={allocation.wants}
              incomeAmount={income?.amount ?? null}
              currency={currency}
              savingCategory={savingCategory}
              errorCategory={errorCategory}
              onCommit={handleCommit}
              onClear={handleClear}
            />
          </>
        )}

        <SavingsSection
          savings={period?.savings ?? []}
          hasIncome={hasIncome}
          currency={currency}
          selectedProfile={selectedProfile}
          applyingProfile={applyingProfile}
          applyError={applyProfile.isError}
          floorBreached={floorBreached}
          floorGap={floorGap}
          groupTotal={allocation?.savings ?? 0}
          incomeAmount={income?.amount ?? null}
          onApply={handleApplyProfile}
        />
      </Box>
    </Box>
  )
}

export default BudgetsPage
