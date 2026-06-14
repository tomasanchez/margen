/**
 * Render checks for the desktop transaction row's FX source indicator
 * (ADR-044/045). A USD row keeps the gold "FX" badge and its <Amount> subline
 * shows the rate value AND its source — "MEP" for a confirmed suggestion,
 * "manual" for a user-entered/overridden rate — so the user always knows
 * "which dollar". An ARS row shows no FX subline.
 */

import { expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { darkTheme } from '../../theme'
import { TransactionRow } from './TransactionRow'
import type { Transaction } from '../../mock/types'

const baseUsd: Transaction = {
  id: 'usd-1',
  occurredOn: '2026-06-12',
  dispDate: 'Jun 12',
  month: 'June',
  name: 'Invoice · Atlas Co.',
  category: 'Income',
  bank: 'Transfer',
  currency: 'USD',
  type: 'income',
  kind: 'invoice',
  amountNum: 622500,
  usd: 500,
  rate: 1245,
  fxRateType: 'MEP',
}

function renderRow(t: Transaction) {
  return render(
    <ThemeProvider theme={darkTheme}>
      <TransactionRow transaction={t} onEdit={() => {}} onDelete={() => {}} />
    </ThemeProvider>,
  )
}

test('a USD row from a confirmed MEP suggestion shows the FX badge + "MEP" source', () => {
  renderRow(baseUsd)
  expect(screen.getByText('FX')).toBeInTheDocument()
  expect(screen.getByText('USD 500 · MEP 1.245')).toBeInTheDocument()
})

test('a USD row with a manual rate shows the "manual" source', () => {
  renderRow({ ...baseUsd, rate: 1300, amountNum: 650000, fxRateType: 'manual' })
  expect(screen.getByText('USD 500 · manual 1.300')).toBeInTheDocument()
})

test('a USD row from the official dollar shows the "official" source', () => {
  renderRow({ ...baseUsd, rate: 1045, amountNum: 522500, fxRateType: 'official' })
  expect(screen.getByText('USD 500 · official 1.045')).toBeInTheDocument()
})

test('an ARS row shows no FX badge or subline', () => {
  renderRow({
    ...baseUsd,
    currency: 'ARS',
    type: 'expense',
    kind: 'expense',
    usd: undefined,
    rate: undefined,
    fxRateType: undefined,
  })
  expect(screen.queryByText('FX')).not.toBeInTheDocument()
  expect(screen.queryByText(/· (MEP|manual)/)).not.toBeInTheDocument()
})
