/**
 * AuthBootstrap — the calm "checking your session" screen (ADR-037).
 *
 * Shown by {@link AuthProvider} only while the initial `getSession()` check is
 * in flight (typically a single frame). It deliberately mirrors the app's quiet
 * tone: the brand wordmark, a small spinner, and a polite line — never a jarring
 * blank flash or the login form for someone who is already signed in. Status is
 * carried by text + a labelled spinner, not by color alone (ADR-019 / HIG).
 *
 * It renders inside the theme provider (AuthProvider is mounted below
 * ColorModeProvider in main.tsx), so it picks up the active palette + fonts.
 */

import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'

export function AuthBootstrap() {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        bgcolor: 'background.default',
        color: 'text.primary',
        p: 3,
      }}
    >
      <Typography
        component="span"
        sx={{ fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em' }}
      >
        Margen
      </Typography>
      <CircularProgress size={22} aria-hidden color="inherit" />
      <Typography variant="body2" color="text.secondary">
        Checking your session…
      </Typography>
    </Box>
  )
}

export default AuthBootstrap
