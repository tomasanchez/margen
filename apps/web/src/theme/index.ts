import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles'

/**
 * `colorSpace` is an internal (not yet publicly typed) createTheme option that
 * switches MUI's color manipulation to CSS color-mix / relative-color syntax.
 * We extend ThemeOptions locally so we can pass it type-safely.
 */
type ThemeOptionsWithColorSpace = ThemeOptions & { colorSpace?: string }

// Self-host the brand fonts (ADR-016) so they are offline/CI-deterministic and
// not a render-blocking CDN request. Hanken Grotesk drives the UI; IBM Plex Mono
// renders financial numbers. Imported once here, where the theme references them.
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'

export type ColorMode = 'dark' | 'light'

/** UI font stack (Hanken Grotesk, with system fallbacks). */
export const fontFamily =
  "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/**
 * Monospaced family for all financial numbers (ADR-013/016).
 * Exposed as a token so the `<Amount>` component and number cells share it.
 */
export const monoFontFamily = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace"

/**
 * Build the Margen MUI theme for a color mode (ADR-013, ADR-021).
 *
 * Palette values READ the shared CSS-variable design tokens (tokens.css) rather
 * than hardcoding hex, so MUI and Tailwind resolve to the exact same colors and
 * dark/light swapping happens by changing the variables — not the theme object.
 * Semantic mapping: success -> Safe, warning -> Watch, error -> Risk.
 *
 * `colorSpace: 'srgb'` switches MUI's color math (alpha/lighten/darken and the
 * derived light/dark shades) from numeric parsing to CSS `color-mix` / relative
 * `oklch(from …)`. That is what makes `var(--mg-*)` palette values work: MUI
 * never tries to decompose a CSS variable into channels. `colorSpace` is an
 * internal createTheme option, so the options object is cast accordingly.
 */
export function buildTheme(mode: ColorMode): Theme {
  const options: ThemeOptionsWithColorSpace = {
    colorSpace: 'srgb',
    palette: {
      mode,
      // Every intent supplies main/light/dark/contrastText explicitly. MUI's
      // augmentColor would otherwise call lighten()/darken()/getContrastRatio()
      // on the value — which it cannot do on a `var(--mg-*)` reference. Giving
      // all four shades keeps the CSS-variable tokens as the single source of
      // truth while skipping MUI's channel math entirely.
      primary: {
        main: 'var(--mg-gold)',
        light: 'var(--mg-gold)',
        dark: 'var(--mg-gold-hover)',
        contrastText: 'var(--mg-on-gold)',
      },
      secondary: {
        main: 'var(--mg-text-2)',
        light: 'var(--mg-text-mid)',
        dark: 'var(--mg-text-3)',
        contrastText: 'var(--mg-bg)',
      },
      success: {
        main: 'var(--mg-safe)',
        light: 'var(--mg-safe)',
        dark: 'var(--mg-safe)',
        contrastText: 'var(--mg-on-gold)',
      },
      warning: {
        main: 'var(--mg-watch)',
        light: 'var(--mg-watch)',
        dark: 'var(--mg-watch)',
        contrastText: 'var(--mg-on-gold)',
      },
      error: {
        main: 'var(--mg-risk)',
        light: 'var(--mg-risk)',
        dark: 'var(--mg-risk)',
        contrastText: 'var(--mg-on-gold)',
      },
      info: {
        main: 'var(--mg-gold)',
        light: 'var(--mg-gold)',
        dark: 'var(--mg-gold-hover)',
        contrastText: 'var(--mg-on-gold)',
      },
      background: {
        default: 'var(--mg-bg)',
        paper: 'var(--mg-paper)',
      },
      text: {
        primary: 'var(--mg-text)',
        secondary: 'var(--mg-text-2)',
        disabled: 'var(--mg-text-3)',
      },
      divider: 'var(--mg-border-2)',
    },
    shape: {
      borderRadius: 14,
    },
    typography: {
      fontFamily,
      h1: { fontWeight: 600, letterSpacing: '-0.02em' },
      h2: { fontWeight: 600, letterSpacing: '-0.02em' },
      h3: { fontWeight: 600, letterSpacing: '-0.02em' },
      h4: { fontWeight: 600, letterSpacing: '-0.01em' },
      h5: { fontWeight: 600, letterSpacing: '-0.01em' },
      h6: { fontWeight: 600, letterSpacing: '-0.01em' },
      // Uppercase, letter-spaced eyebrow labels (concept identity).
      overline: {
        fontWeight: 600,
        fontSize: '0.72rem',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--mg-text-3)',
      },
      button: {
        textTransform: 'none',
        fontWeight: 600,
      },
    },
    components: {
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: 'var(--mg-paper)',
            backgroundImage: 'none',
            border: '1px solid var(--mg-border)',
          },
          outlined: {
            borderColor: 'var(--mg-border-2)',
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: 'var(--mg-paper-2)',
            backgroundImage: 'none',
            border: '1px solid var(--mg-border)',
            borderRadius: 18,
            // Restrained, single soft shadow — no heavy elevation stacks.
            boxShadow: '0 24px 48px -32px rgba(0, 0, 0, 0.55)',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            fontWeight: 600,
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 11,
          },
          // MUI v9 split variant/color slots: scope the contained-primary look
          // (gold fill, --mg-on-gold text) via ownerState rather than a removed
          // `containedPrimary` slot.
          contained: ({ ownerState }) =>
            ownerState.color === 'primary'
              ? {
                  color: 'var(--mg-on-gold)',
                  backgroundColor: 'var(--mg-gold)',
                  '&:hover': {
                    backgroundColor: 'var(--mg-gold-hover)',
                  },
                }
              : {},
        },
      },
    },
  }

  return createTheme(options)
}

/** Pre-built themes for each mode (cheap to build, handy for tests/storybook). */
export const darkTheme = buildTheme('dark')
export const lightTheme = buildTheme('light')
