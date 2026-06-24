/**
 * LoginPage — the public sign-in surface (ADR-096, ADR-013, ADR-019, ADR-037).
 *
 * Two ways in, per ADR-096:
 *   1. Email + password (`signInWithPassword`).
 *   2. "Continue with Google" (`signInWithOAuth` → redirect; the client's
 *      `detectSessionInUrl` finishes the handshake on the way back).
 *
 * The page is themed to the Margen identity (gold primary, Hanken Grotesk) and
 * accessible (labelled fields, a real `<form>` that submits on Enter, a visible
 * focus ring on the submit, an `aria-live` error region, and a busy state that
 * disables the controls). Errors are shown calmly inline (ADR-037) — never a
 * crash and never an auto-dismissing toast for something the user must read.
 *
 * It does NOT decide whether the user is already authenticated — the route's
 * `beforeLoad` redirects an authenticated visitor away before this renders
 * (see {@link router}). As a belt-and-braces fallback it also redirects in an
 * effect if the session appears while the page is mounted (e.g. OAuth return).
 */

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import GoogleIcon from '@mui/icons-material/Google'
import { useAuth } from '../../auth/useAuth'

export interface LoginPageProps {
  /** Where to go after a successful sign-in (validated by the route). */
  redirectTo?: string
}

export function LoginPage({ redirectTo = '/' }: LoginPageProps) {
  const { session, signInWithPassword, signInWithGoogle } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const errorId = useId()

  // Belt-and-braces: if a session appears while we're mounted (e.g. the OAuth
  // redirect-back resolves here, or another tab signs in), leave for the target.
  useEffect(() => {
    if (session) {
      void navigate({ to: redirectTo })
    }
  }, [session, navigate, redirectTo])

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: signInError } = await signInWithPassword(email, password)
    if (signInError) {
      setError(signInError)
      setBusy(false)
      return
    }
    // On success, onAuthStateChange updates the session; the effect navigates.
    // Keep `busy` true so the form stays disabled through the transition.
  }

  const handleGoogle = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    const { error: oauthError } = await signInWithGoogle()
    if (oauthError) {
      // OAuth failed before redirecting — surface it and re-enable the form.
      setError(oauthError)
      setBusy(false)
    }
    // On success the browser navigates away to Google; no further work here.
  }

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        px: 2,
        py: 6,
      }}
    >
      <Paper
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: 400,
          p: { xs: 3, sm: 4 },
          borderRadius: '18px',
          bgcolor: 'var(--mg-paper)',
          borderColor: 'var(--mg-border)',
        }}
      >
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Typography
            component="span"
            sx={{
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: '-0.02em',
              color: 'primary.main',
            }}
          >
            Margen
          </Typography>
          <Typography
            component="h1"
            sx={{ mt: 1.5, fontSize: 18, fontWeight: 600 }}
            color="text.primary"
          >
            Sign in to your account
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            Use your email and password, or continue with Google.
          </Typography>
        </Box>

        {error ? (
          <Alert
            severity="error"
            id={errorId}
            sx={{ mb: 2.5, borderRadius: '12px' }}
          >
            {error}
          </Alert>
        ) : null}

        <Box
          component="form"
          onSubmit={handlePasswordSubmit}
          noValidate
          sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            required
            fullWidth
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            slotProps={{
              htmlInput: {
                'aria-describedby': error ? errorId : undefined,
              },
            }}
          />
          <TextField
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            fullWidth
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            slotProps={{
              htmlInput: {
                'aria-describedby': error ? errorId : undefined,
              },
            }}
          />
          <Button
            type="submit"
            variant="contained"
            color="primary"
            size="large"
            disabled={busy}
            startIcon={
              busy ? <CircularProgress size={16} color="inherit" /> : undefined
            }
            sx={{
              mt: 0.5,
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </Box>

        <Divider sx={{ my: 3, color: 'text.secondary', fontSize: 12 }}>
          or
        </Divider>

        <Button
          type="button"
          variant="outlined"
          color="secondary"
          size="large"
          fullWidth
          onClick={handleGoogle}
          disabled={busy}
          startIcon={<GoogleIcon />}
          sx={{
            textTransform: 'none',
            fontWeight: 600,
            borderColor: 'var(--mg-border-2)',
            color: 'text.primary',
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          Continue with Google
        </Button>
      </Paper>
    </Box>
  )
}

export default LoginPage
