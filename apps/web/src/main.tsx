import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import CssBaseline from '@mui/material/CssBaseline'
import GlobalStyles from '@mui/material/GlobalStyles'
import { StyledEngineProvider } from '@mui/material/styles'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { ColorModeProvider } from './theme/colorMode.tsx'
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
          <RouterProvider router={router} />
        </ColorModeProvider>
      </QueryClientProvider>
    </StyledEngineProvider>
  </StrictMode>,
)
