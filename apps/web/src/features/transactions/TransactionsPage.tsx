/**
 * Transactions screen (Issue #12, ADR-017).
 *
 * Search + filters drive a month-grouped list with per-group and overall totals.
 * The desktop layout shows a search bar, a full FilterBar, a column header, and
 * grid rows with hover/focus Edit + Delete actions; the mobile layout (xs–sm)
 * shows a condensed search + type segmented control + a "Filters" button that
 * opens the shared bottom-sheet, then condensed rows. Both surfaces read ONE
 * filter state (useTransactionFilters) so they never diverge, and recompute the
 * filtered list + totals with useMemo from the useTransactions() query.
 *
 * Edit opens the Add/Edit seam (openAdd) with a prefill built from the row; the
 * actual form is a later task. Delete calls the delete mutation directly. Money
 * and grouping reuse <Amount>/format and the pure logic in filtering.ts — no
 * duplicated formatting.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import InputAdornment from '@mui/material/InputAdornment'
import SearchIcon from '@mui/icons-material/Search'
import TuneIcon from '@mui/icons-material/Tune'
import { monoFontFamily } from '../../theme'
import { formatSignedAmount } from '../../lib/format'
import type { Transaction } from '../../mock/types'
import { ErrorState } from '../../components/ErrorState'
import { useAddTransaction } from './addContext'
import {
  TransactionRow,
  TransactionRowMobile,
  DESKTOP_GRID_COLUMNS,
} from './TransactionRow'
import { FilterBar } from './FilterBar'
import { MonthPicker } from './MonthPicker'
import { MobileFilterSheet } from './MobileFilterSheet'
import {
  type FilterControls,
  type UseTransactionFilters,
} from './useTransactionFilters'
import {
  DEFAULT_FILTERS,
  TYPE_OPTIONS,
  activeFilterCount,
  buildEditPrefill,
  filterTransactions,
  hasActiveFilters,
  type TransactionFilters,
  type TransactionGroup,
  type TypeFilter,
} from './filtering'
import { currentViewingMonth } from '../../components/months'
import { useDeleteTransaction, useTransactions } from './queries'

/** Search-box debounce before the query `q` is pushed to the URL (ADR-116). */
const SEARCH_DEBOUNCE_MS = 300

/**
 * Standalone fallback {@link UseTransactionFilters} for renders OUTSIDE a router
 * (component tests that mount `<TransactionsPage />` bare). It mirrors the
 * router-bound default — current-month scope (ADR-040) — with in-memory setters,
 * so the page behaves identically without a route to navigate. The real app
 * always passes the URL-synced bundle from `router.tsx`.
 */
function useStandaloneFilters(): UseTransactionFilters {
  const [filters, setFilters] = useState<TransactionFilters>(() => ({
    ...DEFAULT_FILTERS,
    month: currentViewingMonth(),
  }))
  const controls = useMemo<FilterControls>(
    () => ({
      setSearch: (value) => setFilters((f) => ({ ...f, q: value })),
      setType: (value) => setFilters((f) => ({ ...f, type: value })),
      setCurrency: (value) => setFilters((f) => ({ ...f, currency: value })),
      setMonth: (value) => setFilters((f) => ({ ...f, month: value })),
      toggleCategory: (value) =>
        setFilters((f) => ({
          ...f,
          categories: f.categories.includes(value)
            ? f.categories.filter((c) => c !== value)
            : [...f.categories, value],
        })),
      toggleBank: (value) =>
        setFilters((f) => ({
          ...f,
          banks: f.banks.includes(value)
            ? f.banks.filter((b) => b !== value)
            : [...f.banks, value],
        })),
      toggleAccount: (value) =>
        setFilters((f) => ({
          ...f,
          accounts: f.accounts.includes(value)
            ? f.accounts.filter((a) => a !== value)
            : [...f.accounts, value],
        })),
      setAmount: (value) => setFilters((f) => ({ ...f, amount: value })),
      clear: () => setFilters(DEFAULT_FILTERS),
    }),
    [],
  )
  return { filters, controls }
}

/** Summary line: "<count> shown · <in> in · <out> out · net <net>". */
function SummaryLine({
  count,
  inflow,
  outflow,
  net,
}: {
  count: number
  inflow: number
  outflow: number
  net: number
}) {
  const { t } = useTranslation('transactions')
  const netPositive = net >= 0
  const numberSx = { fontFamily: monoFontFamily } as const
  return (
    <Typography
      variant="body2"
      component="p"
      color="text.secondary"
      sx={{ mt: 0.5 }}
    >
      <Box component="span" sx={{ ...numberSx, color: 'var(--mg-text-mid)' }}>
        {count}
      </Box>{' '}
      {t('summary.shown')} ·{' '}
      <Box component="span" sx={{ ...numberSx, color: 'var(--mg-safe)' }}>
        {formatSignedAmount(inflow, 'income')}
      </Box>{' '}
      {t('summary.in')} ·{' '}
      <Box component="span" sx={{ ...numberSx, color: 'var(--mg-amount)' }}>
        {formatSignedAmount(outflow, 'expense')}
      </Box>{' '}
      {t('summary.out')} · {t('summary.net')}{' '}
      <Box
        component="span"
        sx={{
          ...numberSx,
          color: netPositive ? 'var(--mg-safe)' : 'var(--mg-risk)',
        }}
      >
        {formatSignedAmount(Math.abs(net), netPositive ? 'income' : 'expense')}
      </Box>
    </Typography>
  )
}

/** Per-month header: month + count, then group in/out totals (mono). */
function GroupHeader({
  group,
  compact,
}: {
  group: TransactionGroup
  compact?: boolean
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 0.5,
        pt: compact ? 1 : 1.75,
        pb: 1,
      }}
    >
      <Typography
        component="h3"
        sx={{ fontSize: compact ? 12 : 13, fontWeight: 600 }}
        color="var(--mg-text-mid)"
      >
        {group.month}{' '}
        <Box
          component="span"
          sx={{
            fontFamily: monoFontFamily,
            fontWeight: 400,
            fontSize: 12,
            color: 'text.disabled',
          }}
        >
          · {group.count}
        </Box>
      </Typography>
      <Box
        sx={{
          fontFamily: monoFontFamily,
          fontSize: compact ? 11 : 12,
          display: 'flex',
          gap: 0.75,
        }}
      >
        {!compact ? (
          <Box component="span" sx={{ color: 'var(--mg-safe)' }}>
            {formatSignedAmount(group.inflow, 'income')}
          </Box>
        ) : null}
        {!compact ? (
          <Box component="span" sx={{ color: 'text.disabled' }}>
            ·
          </Box>
        ) : null}
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {formatSignedAmount(group.outflow, 'expense')}
        </Box>
      </Box>
    </Box>
  )
}

/** Centered empty state shown when nothing matches (import is out of scope). */
function EmptyState({
  active,
  onClear,
}: {
  active: boolean
  onClear: () => void
}) {
  const { t } = useTranslation('transactions')
  return (
    <Box sx={{ textAlign: 'center', py: { xs: 6, md: 9 }, px: 2.5 }}>
      <Typography sx={{ fontSize: 15, mb: 0.75 }} color="text.secondary">
        {t('empty.title')}
      </Typography>
      {active ? (
        <Typography sx={{ fontSize: 13 }} color="text.disabled">
          {t('empty.tryPrefix')}
          <Box
            component="button"
            type="button"
            onClick={onClear}
            sx={{
              background: 'none',
              border: 'none',
              p: 0,
              font: 'inherit',
              color: 'primary.main',
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {t('empty.clearLink')}
          </Box>
          {t('empty.trySuffix')}
        </Typography>
      ) : null}
    </Box>
  )
}

/** Skeleton placeholder while the (latency-simulated) query resolves. */
function ListSkeleton() {
  return (
    <Box aria-hidden sx={{ mt: 2 }}>
      <Skeleton variant="text" width={160} sx={{ mb: 1.5 }} />
      <Stack spacing={1.25}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            height={52}
            sx={{ borderRadius: '12px' }}
          />
        ))}
      </Stack>
    </Box>
  )
}

/** Desktop grid column header. */
function ColumnHeader() {
  const { t } = useTranslation('transactions')
  const cellSx = {
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: 'text.disabled',
    fontWeight: 600,
  }
  return (
    <Box
      sx={{
        display: { xs: 'none', md: 'grid' },
        gridTemplateColumns: DESKTOP_GRID_COLUMNS,
        gap: 1.75,
        px: 0.5,
        pb: 1.25,
        borderBottom: 1,
        borderColor: 'var(--mg-border)',
      }}
    >
      <Box sx={cellSx}>{t('columns.date')}</Box>
      <Box sx={cellSx}>{t('columns.descriptionAndCard')}</Box>
      <Box sx={cellSx}>{t('columns.category')}</Box>
      <Box sx={{ ...cellSx, textAlign: 'right' }}>{t('columns.amount')}</Box>
      <Box />
    </Box>
  )
}

export interface TransactionsPageProps {
  /**
   * The live, URL-derived filter state (ADR-116). Supplied by `router.tsx`,
   * which owns the router coupling (`useTransactionFilters` reads the validated
   * search params). Optional so the page can render STANDALONE in component
   * tests — when omitted it falls back to an in-memory bundle that mirrors the
   * default current-month scope (the page stays router-agnostic — ADR-062 note).
   */
  filters?: TransactionFilters
  /**
   * The bound filter setters (ADR-116). In the app these navigate in `replace`
   * mode so the URL stays the single source of truth; omit alongside `filters`
   * for the standalone fallback. Both must be supplied together or both omitted.
   */
  controls?: FilterControls
}

export function TransactionsPage({
  filters: filtersProp,
  controls: controlsProp,
}: TransactionsPageProps = {}) {
  const { t } = useTranslation('transactions')
  // Controlled by the route in the app; falls back to a local bundle when the
  // page is rendered bare in tests (the hook is unconditionally called to keep
  // hook order stable — its state is simply ignored when props are provided).
  const standalone = useStandaloneFilters()
  const filters = filtersProp ?? standalone.filters
  const controls = controlsProp ?? standalone.controls
  const { openAdd } = useAddTransaction()
  const transactionsQuery = useTransactions()
  const deleteMutation = useDeleteTransaction()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Search box: keep a local value so typing is instant, then debounce-push `q`
  // to the URL (ADR-116). When the URL `q` changes externally (back/forward, or
  // a drill-in), sync the local value back. We track the last value we pushed so
  // an external change is distinguishable from our own echo (no update loop).
  const [searchInput, setSearchInput] = useState(filters.q)
  const lastPushedRef = useRef(filters.q)
  useEffect(() => {
    // External change (not our own debounce echo): adopt it into the input.
    if (filters.q !== lastPushedRef.current) {
      lastPushedRef.current = filters.q
      setSearchInput(filters.q)
    }
  }, [filters.q])
  useEffect(() => {
    if (searchInput === filters.q) return
    const id = setTimeout(() => {
      lastPushedRef.current = searchInput
      controls.setSearch(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [searchInput, filters.q, controls])

  const allTransactions = useMemo(
    () => transactionsQuery.data ?? [],
    [transactionsQuery.data],
  )

  const result = useMemo(
    () => filterTransactions(allTransactions, filters),
    [allTransactions, filters],
  )

  const isLoading = transactionsQuery.isPending
  const isError = transactionsQuery.isError
  const isEmpty = !isLoading && !isError && result.groups.length === 0
  const filtersActive = hasActiveFilters(filters)
  const mobileFilterCount = activeFilterCount(filters)

  const handleEdit = (t: Transaction) => openAdd(buildEditPrefill(t))
  const handleDelete = (t: Transaction) => deleteMutation.mutate(t.id)
  const deletingId =
    deleteMutation.isPending && typeof deleteMutation.variables === 'string'
      ? deleteMutation.variables
      : null

  return (
    <Box>
      <Box sx={{ mb: 2.5 }}>
        <Typography variant="overline" component="p">
          {t('page.eyebrow')}
        </Typography>
        {/* Heading text kept stable for the shell smoke test (App.test.tsx). */}
        <Typography variant="h4" component="h1" color="text.primary">
          {t('page.heading')}
        </Typography>
        {isError ? (
          <Typography
            variant="body2"
            component="p"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            {t('page.loadError')}
          </Typography>
        ) : !isLoading ? (
          <SummaryLine
            count={result.filteredCount}
            inflow={result.inflow}
            outflow={result.outflow}
            net={result.net}
          />
        ) : (
          <Skeleton variant="text" width={320} sx={{ mt: 0.5 }} />
        )}
      </Box>

      {isError ? (
        <ErrorState
          description={t('page.loadErrorDescription')}
          onRetry={() => void transactionsQuery.refetch()}
        />
      ) : (
        <>
      {/* Desktop search + full filter bar. */}
      <Box sx={{ mb: 2.5 }}>
        <FilterBar
          filters={filters}
          controls={controls}
          allTransactions={allTransactions}
          searchValue={searchInput}
          onSearchChange={setSearchInput}
        />

        {/* Mobile: search + type segmented + Filters (sheet) trigger. */}
        <Box sx={{ display: { xs: 'block', md: 'none' } }}>
          <TextField
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('search.placeholderShort')}
            fullWidth
            size="small"
            type="search"
            slotProps={{
              htmlInput: { 'aria-label': t('search.ariaLabel') },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon
                      fontSize="small"
                      sx={{ color: 'text.disabled' }}
                    />
                  </InputAdornment>
                ),
              },
            }}
            sx={{
              mb: 1.5,
              '& .MuiOutlinedInput-root': {
                bgcolor: 'var(--mg-paper)',
                borderRadius: '11px',
              },
            }}
          />
          {/* Month picker on its own full-width row (the ledger's own
              per-screen month, independent of the Home navigator — ADR-040). */}
          <Box sx={{ mb: 1.5 }}>
            <MonthPicker
              value={filters.month}
              onChange={controls.setMonth}
              occurredOns={allTransactions.map((t) => t.occurredOn)}
              fullWidth
            />
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'stretch' }}>
            <ToggleButtonGroup
              exclusive
              value={filters.type}
              onChange={(_, value: TypeFilter | null) => {
                if (value) controls.setType(value)
              }}
              aria-label={t('filters.typeAriaLabel')}
              sx={{
                flex: 1,
                bgcolor: 'var(--mg-paper)',
                border: '1px solid',
                borderColor: 'var(--mg-border-2)',
                borderRadius: '10px',
                p: '3px',
                gap: '3px',
                '& .MuiToggleButton-root': {
                  flex: 1,
                  border: 'none',
                  borderRadius: '7px !important',
                  py: 0.625,
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: 'text.secondary',
                  textTransform: 'none',
                  '&.Mui-selected': {
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    fontWeight: 600,
                    '&:hover': { bgcolor: 'primary.dark' },
                  },
                },
              }}
            >
              {TYPE_OPTIONS.map((option) => (
                <ToggleButton key={option.id} value={option.id}>
                  {t(`type.${option.id}Short`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Button
              variant="outlined"
              startIcon={<TuneIcon />}
              onClick={() => setSheetOpen(true)}
              sx={{
                flex: 'none',
                textTransform: 'none',
                fontSize: 12.5,
                borderRadius: '10px',
                whiteSpace: 'nowrap',
                color: mobileFilterCount ? 'text.primary' : 'text.secondary',
                borderColor: 'var(--mg-border-2)',
                bgcolor: mobileFilterCount
                  ? 'color-mix(in srgb, var(--mg-gold) 10%, transparent)'
                  : 'var(--mg-paper)',
              }}
            >
              {mobileFilterCount
                ? t('filters.triggerCount', { count: mobileFilterCount })
                : t('filters.trigger')}
            </Button>
          </Stack>
        </Box>
      </Box>

      {isLoading ? (
        <ListSkeleton />
      ) : isEmpty ? (
        <EmptyState active={filtersActive} onClear={controls.clear} />
      ) : (
        <>
          <ColumnHeader />
          <Box>
            {result.groups.map((group) => (
              <Box key={group.month} component="section" sx={{ mt: 0.75 }}>
                <GroupHeader group={group} />
                {/* Desktop grid rows */}
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  {group.items.map((t) => (
                    <TransactionRow
                      key={t.id}
                      transaction={t}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      busy={deletingId === t.id}
                    />
                  ))}
                </Box>
                {/* Mobile condensed rows */}
                <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                  {group.items.map((t) => (
                    <TransactionRowMobile
                      key={t.id}
                      transaction={t}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      busy={deletingId === t.id}
                    />
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        </>
      )}

      <MobileFilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        controls={controls}
        resultCount={result.filteredCount}
      />
        </>
      )}

      {/* Calm, recoverable delete-failure notice (ADR-036/037): the row stays in
          place; dismissing or retrying the delete is the user's choice. */}
      <Snackbar
        open={deleteMutation.isError}
        autoHideDuration={null}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return
          deleteMutation.reset()
        }}
      >
        <Alert
          severity="error"
          variant="filled"
          onClose={() => deleteMutation.reset()}
          sx={{ width: '100%' }}
        >
          {t('page.deleteError')}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default TransactionsPage
