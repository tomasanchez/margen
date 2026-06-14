/**
 * Settings page tests (Issue #10 — ADR-053/054/056/057, test plan ADR-058).
 *
 * Renders the page in isolation under a memory router (RouterProvider renders
 * async, so the first assertion AWAITs a findBy) with the Query + color-mode
 * providers, mocking the HTTP client (`settingsClient`) per ADR-038 so no real
 * `/settings` fetch is hit. The real `queries.ts` hooks run over the mocked
 * client, so the query, the mutation, and the cache-seed + invalidation all
 * exercise their real code paths.
 *
 * Coverage:
 *   - the four controls render with the loaded settings values;
 *   - changing display currency / FX default / category PATCHes the right
 *     partial via `updateSettings`;
 *   - a 422 (SettingsApiError) surfaces a calm inline message and keeps the page
 *     usable;
 *   - the manual-threshold note renders;
 *   - calm loading + error states render.
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
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { ColorModeProvider } from '../../theme/colorMode'
import { SettingsPage } from './SettingsPage'
import { SettingsApiError, type Settings } from '../../api/settingsClient'

// Mock the HTTP client so the page never touches a real backend (ADR-038). The
// query + mutation flow through the real queries.ts hooks over these mocks.
const { fetchMock, updateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
}))

vi.mock('../../api/settingsClient', async () => {
  // Keep the real SettingsApiError class + types; mock only the network entry
  // points so the query/mutation hooks run over the mocks.
  const actual = await vi.importActual<
    typeof import('../../api/settingsClient')
  >('../../api/settingsClient')
  return {
    ...actual,
    fetchSettings: fetchMock,
    updateSettings: updateMock,
  }
})

/** A complete settings row, ARS / MEP / Category C. */
const SETTINGS: Settings = {
  preferredDisplayCurrency: 'ARS',
  fxDefaultRateType: 'MEP',
  monotributoCurrentCategory: 'C',
  monotributoActivityType: 'services',
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute({ component: SettingsPage })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <RouterProvider router={router} />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fetchMock.mockResolvedValue(SETTINGS)
  // updateSettings resolves the full settings row (the mutation seeds the cache).
  updateMock.mockResolvedValue(SETTINGS)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('controls render from the loaded settings', () => {
  test('renders the four controls with their stored values', async () => {
    renderPage()

    // RouterProvider renders async — await the first assertion.
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument()

    // The three selects render as comboboxes with their loaded values.
    expect(
      await screen.findByRole('combobox', { name: 'Currency' }),
    ).toHaveTextContent('ARS (pesos)')
    expect(
      screen.getByRole('combobox', { name: 'Rate source' }),
    ).toHaveTextContent('MEP')
    expect(
      screen.getByRole('combobox', { name: 'Category' }),
    ).toHaveTextContent('Category C')

    // The fixed-services chip is the fourth control's read-only affordance.
    expect(screen.getByText('Services')).toBeInTheDocument()
  })
})

describe('changing a control PATCHes the right partial', () => {
  test('changing display currency to USD saves { preferredDisplayCurrency }', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('combobox', { name: 'Currency' }),
    )
    await user.click(
      await screen.findByRole('option', { name: 'USD (dollars)' }),
    )

    expect(updateMock).toHaveBeenCalledWith({
      preferredDisplayCurrency: 'USD',
    })
  })

  test('changing the FX default to Official saves { fxDefaultRateType }', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('combobox', { name: 'Rate source' }),
    )
    await user.click(await screen.findByRole('option', { name: 'Official' }))

    expect(updateMock).toHaveBeenCalledWith({
      fxDefaultRateType: 'official',
    })
  })

  test('changing the category saves { monotributoCurrentCategory } + activity type', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('combobox', { name: 'Category' }),
    )
    await user.click(await screen.findByRole('option', { name: 'Category E' }))

    expect(updateMock).toHaveBeenCalledWith({
      monotributoCurrentCategory: 'E',
      monotributoActivityType: 'services',
    })
  })
})

describe('a save failure surfaces a calm inline message (ADR-037)', () => {
  test('a 422 shows the "not allowed" message and the page stays usable', async () => {
    updateMock.mockRejectedValue(new SettingsApiError(422, 'unknown category'))
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('combobox', { name: 'Category' }),
    )
    await user.click(await screen.findByRole('option', { name: 'Category K' }))

    // The calm 422 message appears in an alert; the controls are still there.
    expect(
      await screen.findByText(
        "That value isn't allowed. Pick one from the list.",
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Category' }),
    ).toBeInTheDocument()
  })

  test('a non-422 failure shows the generic save error', async () => {
    updateMock.mockRejectedValue(new SettingsApiError(500, 'boom'))
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole('combobox', { name: 'Currency' }),
    )
    await user.click(
      await screen.findByRole('option', { name: 'USD (dollars)' }),
    )

    expect(
      await screen.findByText("We couldn't save that change. Try again."),
    ).toBeInTheDocument()
  })
})

describe('manual-threshold note', () => {
  test('renders the AFIP scale 2026 note', async () => {
    renderPage()

    expect(
      await screen.findByText(
        'Thresholds are manually maintained · AFIP scale 2026',
      ),
    ).toBeInTheDocument()
  })
})

describe('loading and error states (ADR-037)', () => {
  test('renders the calm loading skeleton while settings are pending', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    renderPage()

    // The header is always present; the controls are not yet (skeleton instead).
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Currency' }),
    ).not.toBeInTheDocument()
  })

  test('renders the calm unavailable error state when the GET fails', async () => {
    fetchMock.mockRejectedValue(new SettingsApiError(500, 'boom'))
    renderPage()

    expect(
      await screen.findByText('Settings unavailable'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
