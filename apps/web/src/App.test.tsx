import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '@mui/material/styles'
import App from './App'
import { theme } from './theme'

/**
 * Frontend smoke test (ADR-008).
 *
 * Proves the Margen shell renders and that the connection indicator reaches the
 * "connected" state once the readiness query resolves. The readiness fetch is
 * mocked so the test needs no running backend, and query retries are disabled
 * so any unexpected failure surfaces immediately instead of being masked.
 */

function renderApp() {
  // Fresh client per render with retries off: the error path (if ever hit)
  // should fail fast rather than retry and hang the test.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <App />
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // Mock the readiness endpoint so no real network request is made. The shape
  // mirrors the real API contract: 200 with { data: { status: "Ready" } }.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: { status: 'Ready' } }),
    } as Response),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('renders the Margen shell and reaches the connected state', async () => {
  renderApp()

  // Shell renders immediately with the product name.
  expect(screen.getByText('Margen')).toBeInTheDocument()

  // After the mocked readiness query resolves, the indicator transitions out
  // of "Connecting…" and announces the connected state. findByText waits for
  // that async transition rather than asserting on the initial render.
  const connectedLabel = await screen.findByText('Backend connected')
  expect(connectedLabel).toBeInTheDocument()

  // The chip is an accessible status region announcing the connected state.
  const status = screen.getByRole('status')
  expect(status).toHaveAttribute('aria-label', 'Backend connected')
})
