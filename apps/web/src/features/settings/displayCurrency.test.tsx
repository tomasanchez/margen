/**
 * DisplayCurrencyProvider tests — the single ARS→USD display transform (ADR-056).
 *
 * Wraps a probe component in {@link DisplayCurrencyProvider} with the settings
 * client (`fetchSettings`) and the FX adapter (`fxClient`) mocked per ADR-038 /
 * ADR-044 — no real network. The provider's real `useSettings` query +
 * rate query run over the mocks, so the conversion, the calm fallback, and the
 * ARS-only short-circuit all exercise their real code paths.
 *
 * Coverage:
 *   - USD preferred + a live MEP rate → an ARS figure is converted (divided by
 *     the rate) and prefixed `USD`; effectiveCurrency is USD; no fallback note;
 *   - USD preferred but the rate fetch returns null → falls back to ARS
 *     formatting and exposes the calm `fallbackNote` (ADR-037);
 *   - the configured `official` default fetches the official rate (not MEP);
 *   - ARS preferred → no conversion, no fx fetch at all.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DisplayCurrencyProvider } from './displayCurrency'
import { useDisplayCurrency } from './displayCurrencyContext'
import type { Settings } from '../../api/settingsClient'

// Mock the settings client (drives preferred currency + fx default) and the FX
// adapter (drives the live conversion rate). Both flow through the provider's
// real queries over these mocks (ADR-038 / ADR-044).
const { fetchSettingsMock, mepMock, officialMock } = vi.hoisted(() => ({
  fetchSettingsMock: vi.fn(),
  mepMock: vi.fn(),
  officialMock: vi.fn(),
}))

vi.mock('../../api/settingsClient', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return { ...actual, fetchSettings: fetchSettingsMock }
})

vi.mock('../../api/fxClient', () => ({
  fetchSuggestedMepRate: mepMock,
  fetchSuggestedOfficialRate: officialMock,
}))

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    preferredDisplayCurrency: 'ARS',
    fxDefaultRateType: 'MEP',
    monotributoCurrentCategory: 'C',
    monotributoActivityType: 'services',
    monotributoEnabled: true,
    ...overrides,
  }
}

/** A probe that surfaces the display-currency value for assertions. */
function Probe({ ars }: { ars: number }) {
  const { effectiveCurrency, rate, fallbackNote, formatMoney } =
    useDisplayCurrency()
  return (
    <div>
      <span data-testid="effective">{effectiveCurrency}</span>
      <span data-testid="rate">{rate === null ? 'null' : String(rate)}</span>
      <span data-testid="fallback">{fallbackNote ?? 'none'}</span>
      <span data-testid="money">{formatMoney(ars)}</span>
    </div>
  )
}

function renderProbe(ars: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <DisplayCurrencyProvider>
        <Probe ars={ars} />
      </DisplayCurrencyProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mepMock.mockResolvedValue(1000)
  officialMock.mockResolvedValue(900)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('USD preferred with a live rate', () => {
  test('converts an ARS figure to USD by dividing by the rate', async () => {
    fetchSettingsMock.mockResolvedValue(
      makeSettings({ preferredDisplayCurrency: 'USD', fxDefaultRateType: 'MEP' }),
    )

    // 1.000.000 ARS / 1000 = USD 1.000.
    renderProbe(1_000_000)

    // The probe is always mounted (it renders ARS first), so wait for the
    // converted figure to appear rather than findBy on the always-present node.
    await screen.findByText('USD 1.000')
    expect(screen.getByTestId('effective')).toHaveTextContent('USD')
    expect(screen.getByTestId('rate')).toHaveTextContent('1000')
    expect(screen.getByTestId('money')).toHaveTextContent('USD 1.000')
    expect(screen.getByTestId('fallback')).toHaveTextContent('none')
    // The configured MEP source was fetched; official was not.
    expect(mepMock).toHaveBeenCalled()
    expect(officialMock).not.toHaveBeenCalled()
  })

  test('the configured official default fetches the official rate', async () => {
    fetchSettingsMock.mockResolvedValue(
      makeSettings({
        preferredDisplayCurrency: 'USD',
        fxDefaultRateType: 'official',
      }),
    )

    // 1.800.000 ARS / 900 = USD 2.000.
    renderProbe(1_800_000)

    await screen.findByText('USD 2.000')
    expect(officialMock).toHaveBeenCalled()
    expect(mepMock).not.toHaveBeenCalled()
  })
})

describe('USD preferred but the rate is unavailable', () => {
  test('falls back to ARS formatting and exposes the calm fallback note', async () => {
    fetchSettingsMock.mockResolvedValue(
      makeSettings({ preferredDisplayCurrency: 'USD', fxDefaultRateType: 'MEP' }),
    )
    mepMock.mockResolvedValue(null)

    renderProbe(1_000_000)

    // Once the fetch settles with no usable rate, the surface falls back to ARS.
    await screen.findByText(/couldn't fetch a USD rate/)
    expect(screen.getByTestId('effective')).toHaveTextContent('ARS')
    expect(screen.getByTestId('money')).toHaveTextContent('ARS 1.000.000')
    expect(screen.getByTestId('money')).not.toHaveTextContent('USD')
  })
})

describe('ARS preferred', () => {
  test('does not convert and never fetches a rate', async () => {
    fetchSettingsMock.mockResolvedValue(
      makeSettings({ preferredDisplayCurrency: 'ARS' }),
    )

    renderProbe(1_000_000)

    expect(await screen.findByTestId('money')).toHaveTextContent('ARS 1.000.000')
    expect(screen.getByTestId('effective')).toHaveTextContent('ARS')
    expect(screen.getByTestId('fallback')).toHaveTextContent('none')
    // ARS-preferred users never trigger the rate fetch (ADR-056).
    expect(mepMock).not.toHaveBeenCalled()
    expect(officialMock).not.toHaveBeenCalled()
  })
})
