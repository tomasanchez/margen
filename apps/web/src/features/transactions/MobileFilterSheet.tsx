/**
 * Mobile filter bottom-sheet (ADR-017: the reusable bottom-anchored Drawer).
 *
 * Opened from the mobile "Filters" button, it presents currency / month /
 * category / bank / amount as chip groups (the same shared filter state as the
 * desktop bar), plus a "Clear all" link when anything is active and a primary
 * "Show N transactions" apply button that simply closes the sheet — filtering is
 * live, so the count updates as chips toggle. MUI Drawer traps and restores
 * focus, satisfying the keyboard/focus requirements of ADR-019.
 */

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { BANKS, CATEGORIES } from '../../mock/seed'
import type { Bank, Category, MonthName, Transaction } from '../../mock/types'
import {
  AMOUNT_RANGES,
  CURRENCY_OPTIONS,
  hasActiveFilters,
  presentMonths,
  type AmountRange,
  type CurrencyFilter,
  type TransactionFilters,
} from './filtering'
import type { FilterControls } from './useTransactionFilters'

/** A selectable filter chip (gold-tinted when active), token-driven. */
function FilterChip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <Chip
      label={label}
      onClick={onClick}
      variant="outlined"
      aria-pressed={selected}
      sx={{
        borderRadius: 999,
        fontWeight: selected ? 600 : 500,
        fontSize: 12.5,
        color: selected ? 'text.primary' : 'text.secondary',
        borderColor: selected ? 'primary.main' : 'var(--mg-border-2)',
        bgcolor: selected
          ? 'color-mix(in srgb, var(--mg-gold) 14%, transparent)'
          : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    />
  )
}

/** A labeled group of chips with an uppercase eyebrow heading. */
function ChipSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Box sx={{ mb: 2.25 }}>
      <Typography variant="overline" component="p" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {children}
      </Stack>
    </Box>
  )
}

interface MobileFilterSheetProps {
  open: boolean
  onClose: () => void
  filters: TransactionFilters
  controls: FilterControls
  /** The unfiltered list (drives the present-month chips). */
  allTransactions: readonly Transaction[]
  /** Count of currently-matching rows, shown on the apply button. */
  resultCount: number
}

/** Bottom-anchored filter sheet for xs–sm viewports. */
export function MobileFilterSheet({
  open,
  onClose,
  filters,
  controls,
  allTransactions,
  resultCount,
}: MobileFilterSheetProps) {
  const months = presentMonths(allTransactions)
  const showClear = hasActiveFilters(filters)

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid',
            borderColor: 'var(--mg-border-2)',
            maxHeight: '85vh',
            px: 2.5,
            pt: 2,
            pb: 'calc(env(safe-area-inset-bottom) + 24px)',
          },
        },
      }}
    >
      {/* Grab handle (decorative). */}
      <Box
        aria-hidden
        sx={{
          width: 38,
          height: 4,
          borderRadius: 3,
          bgcolor: 'var(--mg-border-2)',
          mx: 'auto',
          mb: 2,
        }}
      />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Typography variant="h6" component="h2">
          Filters
        </Typography>
        {showClear ? (
          <Button
            onClick={controls.clear}
            sx={{ textTransform: 'none', fontSize: 13, color: 'error.main' }}
          >
            Clear all
          </Button>
        ) : null}
      </Box>

      <ChipSection title="Currency">
        {CURRENCY_OPTIONS.map((option) => (
          <FilterChip
            key={option.id}
            label={option.label}
            selected={filters.currency === option.id}
            onClick={() =>
              controls.setCurrency(option.id as CurrencyFilter)
            }
          />
        ))}
      </ChipSection>

      <ChipSection title="Month">
        <FilterChip
          label="All"
          selected={filters.month === 'all'}
          onClick={() => controls.setMonth('all')}
        />
        {months.map((month: MonthName) => (
          <FilterChip
            key={month}
            label={month}
            selected={filters.month === month}
            onClick={() => controls.setMonth(month)}
          />
        ))}
      </ChipSection>

      <ChipSection title="Category">
        {CATEGORIES.map((category: Category) => (
          <FilterChip
            key={category}
            label={category}
            selected={filters.categories.includes(category)}
            onClick={() => controls.toggleCategory(category)}
          />
        ))}
      </ChipSection>

      <ChipSection title="Bank / card">
        {BANKS.map((bank: Bank) => (
          <FilterChip
            key={bank}
            label={bank}
            selected={filters.banks.includes(bank)}
            onClick={() => controls.toggleBank(bank)}
          />
        ))}
      </ChipSection>

      <ChipSection title="Amount">
        {AMOUNT_RANGES.map((range) => (
          <FilterChip
            key={range.id}
            label={range.label}
            selected={filters.amount === range.id}
            onClick={() => controls.setAmount(range.id as AmountRange)}
          />
        ))}
      </ChipSection>

      <Button
        variant="contained"
        color="primary"
        fullWidth
        onClick={onClose}
        sx={{ py: 1.5, fontWeight: 600 }}
      >
        Show {resultCount} {resultCount === 1 ? 'transaction' : 'transactions'}
      </Button>
    </Drawer>
  )
}
