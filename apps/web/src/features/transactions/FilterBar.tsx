/**
 * Desktop filter bar for the Transactions screen (ADR-017).
 *
 * A search field (matches name OR category), two segmented controls (type and
 * currency) built on MUI ToggleButtonGroup, multi-select Category and Bank menus
 * with per-option counts, an amount-range select menu, and a "Clear filters"
 * affordance that appears only when something is active. The gold active state
 * comes from the theme primary token; everything is keyboard-operable and
 * carries accessible names (ADR-019).
 *
 * The bar is presentational: it reads `filters` and calls `controls`; all state
 * lives in useTransactionFilters so the desktop bar and mobile sheet share it.
 */

import { useId, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import SearchIcon from '@mui/icons-material/Search'
import { monoFontFamily } from '../../theme'
import { BANKS, CATEGORIES } from '../../mock/seed'
import type { Bank, Category, Transaction } from '../../mock/types'
import {
  AMOUNT_RANGES,
  CURRENCY_OPTIONS,
  TYPE_OPTIONS,
  countByBank,
  countByCategory,
  hasActiveFilters,
  type AmountRange,
  type CurrencyFilter,
  type TransactionFilters,
  type TypeFilter,
} from './filtering'
import type { FilterControls } from './useTransactionFilters'

/** Shared sx for the segmented ToggleButtonGroups (pill segments, gold active). */
const segmentedGroupSx = {
  bgcolor: 'var(--mg-paper)',
  border: '1px solid',
  borderColor: 'var(--mg-border-2)',
  borderRadius: '10px',
  p: '3px',
  gap: '3px',
  '& .MuiToggleButton-root': {
    border: 'none',
    borderRadius: '8px !important',
    px: 1.75,
    py: 0.75,
    fontSize: 13,
    fontWeight: 500,
    color: 'text.secondary',
    textTransform: 'none',
    lineHeight: 1.4,
    '&:hover': { bgcolor: 'action.hover' },
    '&.Mui-selected': {
      bgcolor: 'primary.main',
      color: 'primary.contrastText',
      fontWeight: 600,
      '&:hover': { bgcolor: 'primary.dark' },
    },
  },
} as const

/** A pill "dropdown trigger" button matching the concept filter chips. */
function FilterMenuButton({
  active,
  label,
  onClick,
  ...rest
}: {
  active: boolean
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
} & Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  return (
    <Button
      variant="outlined"
      onClick={onClick}
      endIcon={<ArrowDropDownIcon />}
      {...rest}
      sx={{
        textTransform: 'none',
        fontSize: 13,
        fontWeight: 500,
        px: 1.75,
        py: 1,
        borderRadius: '9px',
        whiteSpace: 'nowrap',
        color: active ? 'text.primary' : 'text.secondary',
        borderColor: active ? 'var(--mg-border-2)' : 'var(--mg-border-2)',
        bgcolor: active
          ? 'color-mix(in srgb, var(--mg-gold) 10%, transparent)'
          : 'var(--mg-paper)',
        '&:hover': { bgcolor: 'action.hover', borderColor: 'var(--mg-border-2)' },
      }}
    >
      {label}
    </Button>
  )
}

interface MultiSelectMenuProps<T extends string> {
  buttonLabel: string
  baseLabel: string
  options: readonly T[]
  selected: T[]
  countOf: (option: T) => number
  onToggle: (option: T) => void
}

/** A bordered trigger that opens a checkbox menu with per-option counts. */
function MultiSelectMenu<T extends string>({
  buttonLabel,
  baseLabel,
  options,
  selected,
  countOf,
  onToggle,
}: MultiSelectMenuProps<T>) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()
  const label = selected.length
    ? `${baseLabel} · ${selected.length}`
    : buttonLabel

  return (
    <>
      <FilterMenuButton
        active={selected.length > 0}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => setAnchorEl(e.currentTarget)}
      />
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        slotProps={{ paper: { sx: { width: 240, mt: 1, maxHeight: 320 } } }}
      >
        {options.map((option) => {
          const isSelected = selected.includes(option)
          return (
            <MenuItem
              key={option}
              onClick={() => onToggle(option)}
              dense
              sx={{ borderRadius: 1.5, mx: 0.5, my: 0.25 }}
            >
              <Checkbox
                edge="start"
                size="small"
                checked={isSelected}
                tabIndex={-1}
                disableRipple
                sx={{ p: 0, mr: 1, color: 'var(--mg-border-2)' }}
              />
              <ListItemText
                primary={option}
                slotProps={{ primary: { sx: { fontSize: 13 } } }}
              />
              <Typography
                component="span"
                sx={{
                  fontFamily: monoFontFamily,
                  fontSize: 11,
                  color: 'text.disabled',
                  ml: 1.5,
                }}
              >
                {countOf(option)}
              </Typography>
            </MenuItem>
          )
        })}
      </Menu>
    </>
  )
}

/** Single-select amount-range menu. */
function AmountMenu({
  value,
  onChange,
}: {
  value: AmountRange
  onChange: (value: AmountRange) => void
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const menuId = useId()
  const active = value !== 'any'
  const label =
    AMOUNT_RANGES.find((r) => r.id === value)?.label ?? 'Amount'

  return (
    <>
      <FilterMenuButton
        active={active}
        label={active ? label : 'Amount'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => setAnchorEl(e.currentTarget)}
      />
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        slotProps={{ paper: { sx: { width: 240, mt: 1 } } }}
      >
        {AMOUNT_RANGES.map((range) => (
          <MenuItem
            key={range.id}
            selected={range.id === value}
            onClick={() => {
              onChange(range.id)
              setAnchorEl(null)
            }}
            dense
            sx={{ borderRadius: 1.5, mx: 0.5, my: 0.25, fontSize: 13 }}
          >
            {range.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

interface FilterBarProps {
  filters: TransactionFilters
  controls: FilterControls
  /** The unfiltered list, used for the per-option counts in the menus. */
  allTransactions: readonly Transaction[]
}

/** Desktop search + filter bar. Hidden on xs–sm (the sheet covers mobile). */
export function FilterBar({
  filters,
  controls,
  allTransactions,
}: FilterBarProps) {
  const showClear = hasActiveFilters(filters)

  return (
    <Box sx={{ display: { xs: 'none', md: 'block' } }}>
      <TextField
        value={filters.q}
        onChange={(e) => controls.setSearch(e.target.value)}
        placeholder="Search description or category…"
        fullWidth
        size="small"
        type="search"
        slotProps={{
          htmlInput: { 'aria-label': 'Search transactions' },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" sx={{ color: 'text.disabled' }} />
              </InputAdornment>
            ),
          },
        }}
        sx={{
          mb: 1.75,
          '& .MuiOutlinedInput-root': {
            bgcolor: 'var(--mg-paper)',
            borderRadius: '11px',
          },
        }}
      />

      <Stack
        direction="row"
        spacing={1.25}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center' }}
      >
        <ToggleButtonGroup
          exclusive
          value={filters.type}
          onChange={(_, value: TypeFilter | null) => {
            if (value) controls.setType(value)
          }}
          aria-label="Transaction type"
          sx={segmentedGroupSx}
        >
          {TYPE_OPTIONS.map((option) => (
            <ToggleButton key={option.id} value={option.id}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <ToggleButtonGroup
          exclusive
          value={filters.currency}
          onChange={(_, value: CurrencyFilter | null) => {
            if (value) controls.setCurrency(value)
          }}
          aria-label="Currency"
          sx={segmentedGroupSx}
        >
          {CURRENCY_OPTIONS.map((option) => (
            <ToggleButton key={option.id} value={option.id}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <MultiSelectMenu<Category>
          buttonLabel="Category"
          baseLabel="Category"
          options={CATEGORIES}
          selected={filters.categories}
          countOf={(c) => countByCategory(allTransactions, c)}
          onToggle={controls.toggleCategory}
        />

        <MultiSelectMenu<Bank>
          buttonLabel="Bank / card"
          baseLabel="Bank / card"
          options={BANKS}
          selected={filters.banks}
          countOf={(b) => countByBank(allTransactions, b)}
          onToggle={controls.toggleBank}
        />

        <AmountMenu value={filters.amount} onChange={controls.setAmount} />

        {showClear ? (
          <Button
            onClick={controls.clear}
            sx={{
              textTransform: 'none',
              fontSize: 13,
              color: 'error.main',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </Stack>
    </Box>
  )
}
