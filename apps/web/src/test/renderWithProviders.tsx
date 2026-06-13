/**
 * Test helper: render a component under the providers the Transactions / Add
 * features need (ADR-018).
 *
 * Wraps the tree in a fresh QueryClient (retries OFF, so a rejected mock call
 * fails fast instead of retrying through the simulated latency) and the
 * ColorModeProvider/ThemeProvider so MUI components resolve their theme. The
 * Add-flow seam (AddTransactionProvider) is opt-in via `withAddProvider` for the
 * tests that drive openAdd / render the Add dialog.
 *
 * Routing is intentionally NOT included here — the components under test
 * (TransactionsPage, AddEditForm) render standalone; the routed shell already
 * has its own smoke test in App.test.tsx.
 */

import type { ReactElement, ReactNode } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../theme/colorMode'
import { AddTransactionProvider } from '../features/transactions/AddTransactionProvider'

export interface RenderWithProvidersOptions {
  /** Wrap in the Add-flow seam so openAdd/closeAdd + the Add dialog work. */
  withAddProvider?: boolean
}

/** Build a QueryClient configured for tests (no retries). */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

/** Render `ui` wrapped in the app providers; returns the RTL result. */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = makeTestQueryClient()

  const Wrapper = ({ children }: { children: ReactNode }) => {
    const themed = (
      <QueryClientProvider client={queryClient}>
        <ColorModeProvider>{children}</ColorModeProvider>
      </QueryClientProvider>
    )
    return options.withAddProvider ? (
      <QueryClientProvider client={queryClient}>
        <ColorModeProvider>
          <AddTransactionProvider>{children}</AddTransactionProvider>
        </ColorModeProvider>
      </QueryClientProvider>
    ) : (
      themed
    )
  }

  const result = render(ui, { wrapper: Wrapper })
  return { ...result, queryClient }
}
