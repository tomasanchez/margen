import { createContext, useContext } from 'react'
import type { ColorMode } from './index'

export interface ColorModeContextValue {
  /** Current color mode. */
  mode: ColorMode
  /** Switch to an explicit mode. */
  setMode: (mode: ColorMode) => void
  /** Flip between dark and light. */
  toggle: () => void
}

/**
 * Color-mode context (ADR-013).
 *
 * Kept in a non-component module so the provider component file stays
 * Fast-Refresh-friendly (it must only export components).
 */
export const ColorModeContext = createContext<ColorModeContextValue | null>(null)

/** Access the current color mode and its setters. Must be used under the provider. */
export function useColorMode(): ColorModeContextValue {
  const ctx = useContext(ColorModeContext)
  if (!ctx) {
    throw new Error('useColorMode must be used within a ColorModeProvider')
  }
  return ctx
}
