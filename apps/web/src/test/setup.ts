/**
 * Vitest global setup (ADR-008).
 *
 * Registers jest-dom's custom matchers (e.g. toBeInTheDocument) and cleans up
 * the rendered DOM between tests so the lightweight frontend suite stays
 * isolated and order-independent.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
