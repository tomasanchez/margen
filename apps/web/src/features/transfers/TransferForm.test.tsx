/**
 * Regression test for the MUI-v9 Typography `color`-prop bug (color-prop audit).
 *
 * In MUI v9 the Typography `color` PROP only maps the fixed token strings
 * (`error`, `primary`, `textSecondary`, …). A DOTTED palette path like
 * `color="error.main"` matches no variant and emits NO color, so the text
 * silently inherits the primary text color instead of the theme error token —
 * a real bug for the form save-error alerts (ADR-037), whose whole point is to
 * read as an error. The fix routes the error color through `sx` (which DOES
 * resolve the palette path). This test pins the alert to the resolved error
 * token (`var(--mg-risk)`, see theme/index.ts) so a revert to the bare prop
 * (which would inherit and fail this assertion) is caught.
 *
 * English-pinned (ADR-105). The form is rendered directly with `saveError` set,
 * under the real Margen theme via `renderWithProviders`.
 */

import { describe, expect, test, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../test/renderWithProviders'
import { TransferForm } from './TransferForm'
import type { Account } from '../../mock/types'

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    institutionId: 'i1',
    institutionName: 'Galicia',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '150000.00',
  },
  {
    id: 'a2',
    institutionId: 'i2',
    institutionName: 'Brubank',
    type: 'bank',
    currency: 'ARS',
    openingBalance: '10000.00',
  },
]

describe('TransferForm save-error alert color', () => {
  test('the save-error alert renders in the theme error token, not inherited text', () => {
    renderWithProviders(
      <TransferForm
        open
        accounts={ACCOUNTS}
        isSaving={false}
        saveError
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const alert = screen.getByRole('alert')
    // The `sx` color path resolves the dotted palette token to the theme's error
    // CSS variable. A bare `color="error.main"` prop would emit nothing and this
    // would inherit `var(--mg-text)` instead — exactly the bug under audit.
    expect(alert).toHaveStyle({ color: 'var(--mg-risk)' })
    // Guard against a false positive: the alert must NOT be the primary text
    // color (what the broken prop form silently fell back to).
    expect(alert).not.toHaveStyle({ color: 'var(--mg-text)' })
  })
})
