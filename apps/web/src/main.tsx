import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import CssBaseline from '@mui/material/CssBaseline'
import GlobalStyles from '@mui/material/GlobalStyles'
import { StyledEngineProvider } from '@mui/material/styles'
import './index.css'
import { ColorModeProvider } from './theme/colorMode.tsx'
import { LanguageProvider } from './i18n/LanguageProvider.tsx'
import { DisplayCurrencyProvider } from './features/settings/displayCurrency.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { AppRouter } from './router/AppRouter.tsx'
import { queryClient } from './queryClient.ts'
import { router } from './router.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* enableCssLayer emits MUI styles into the `mui` cascade layer; the
        GlobalStyles rule declares the layer order so `utilities` (Tailwind)
        come after `mui` and can override it when intended (ADR-021). */}
    <StyledEngineProvider enableCssLayer>
      <GlobalStyles styles="@layer theme, base, mui, components, utilities;" />
      <QueryClientProvider client={queryClient}>
        <ColorModeProvider>
          <CssBaseline />
          {/* AuthProvider owns the Supabase session and gates the tree on the
              initial session check (ADR-096). On every auth change it
              invalidates the router so `beforeLoad` re-evaluates the guards —
              sign-in unlocks the app, sign-out bounces to /login. AppRouter
              reads the live auth value and feeds it to the router context. */}
          <AuthProvider onAuthChange={() => void router.invalidate()}>
            <DisplayCurrencyProvider>
              {/* LanguageProvider bootstraps the i18n singleton and exposes the
                  active language + setter via useLanguage. Mounted inside the
                  app providers so every consumer (including AppRouter) can
                  translate and read the language (ADR-101). */}
              <LanguageProvider>
                <AppRouter />
              </LanguageProvider>
            </DisplayCurrencyProvider>
          </AuthProvider>
        </ColorModeProvider>
      </QueryClientProvider>
    </StyledEngineProvider>
  </StrictMode>,
)
