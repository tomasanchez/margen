import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import { buildTheme, type ColorMode } from './index'
import { ColorModeContext } from './colorModeContext'

const STORAGE_KEY = 'margen.colorMode'
const DEFAULT_MODE: ColorMode = 'dark'

/**
 * Reflect the active color mode onto <html data-color-mode="…">.
 *
 * tokens.css scopes its light overrides to :root[data-color-mode='light'], so
 * setting this attribute swaps every design-token value (and thus both MUI and
 * Tailwind colors) at once.
 */
function applyMode(mode: ColorMode): void {
  document.documentElement.setAttribute('data-color-mode', mode)
}

function readInitialMode(): ColorMode {
  if (typeof window === 'undefined') return DEFAULT_MODE
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_MODE
}

/**
 * Provides the Margen color mode + the matching MUI theme (ADR-013).
 *
 * Defaults to dark, persists the user's choice, writes the data-color-mode
 * attribute so the CSS-variable tokens swap, and supplies the corresponding
 * MUI theme. Wrap the app tree below QueryClientProvider.
 */
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(readInitialMode)

  // Keep the DOM attribute and persistence in sync with the active mode.
  useEffect(() => {
    applyMode(mode)
    window.localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  const setMode = useCallback((next: ColorMode) => setModeState(next), [])
  const toggle = useCallback(
    () => setModeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  )

  const theme = useMemo(() => buildTheme(mode), [mode])
  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle])

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </ColorModeContext.Provider>
  )
}
