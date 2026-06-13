import { QueryClient } from '@tanstack/react-query'

/**
 * Shared TanStack Query client for the Margen app.
 *
 * Conservative defaults suited to a finance dashboard: data is treated as
 * fresh for a short window to avoid redundant refetches, and transient
 * failures are retried a bounded number of times.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
})

export default queryClient
