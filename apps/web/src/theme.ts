import { createTheme } from '@mui/material/styles'

/**
 * Margen theme — calm, restrained, finance-oriented.
 *
 * Design intent (Apple HIG-aligned): a sober, neutral surface with a single
 * muted slate-blue accent, comfortable spacing, and quiet typography. No loud
 * gradients or saturated colors. State is never conveyed by color alone in the
 * wider app; this theme only establishes the foundational palette and shape.
 */
export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      // Muted slate blue — trustworthy, not flashy.
      main: '#3a4a63',
      light: '#5c6b82',
      dark: '#27344a',
      contrastText: '#ffffff',
    },
    secondary: {
      // Soft sage as a quiet supporting tone.
      main: '#5f7368',
      contrastText: '#ffffff',
    },
    success: { main: '#3f7d5b' },
    warning: { main: '#a9772f' },
    error: { main: '#9e453f' },
    info: { main: '#42627d' },
    background: {
      default: '#f7f8fa',
      paper: '#ffffff',
    },
    text: {
      primary: '#1f2733',
      secondary: '#5a6573',
    },
    divider: 'rgba(31, 39, 51, 0.1)',
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily:
      '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    h1: { fontWeight: 600, letterSpacing: '-0.02em' },
    h2: { fontWeight: 600, letterSpacing: '-0.015em' },
    h3: { fontWeight: 600, letterSpacing: '-0.01em' },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    button: {
      textTransform: 'none',
      fontWeight: 600,
    },
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
    },
    MuiPaper: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        outlined: {
          borderColor: 'rgba(31, 39, 51, 0.12)',
        },
      },
    },
  },
})

export default theme
