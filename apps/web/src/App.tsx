import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ConnectionStatus } from './components/ConnectionStatus'

/**
 * Margen application shell (ADR-005).
 *
 * A calm, finance-oriented frame: a quiet header carrying the product name and
 * a live backend connection indicator, over a deliberate empty-state content
 * area. Product features (entry, dashboards, auth) are intentionally out of
 * scope here — this is the foundation shell only.
 */
function App() {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <AppBar
        position="static"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Toolbar>
          <Typography
            variant="h6"
            component="span"
            sx={{ flexGrow: 1, fontWeight: 700, letterSpacing: '-0.01em' }}
            color="text.primary"
          >
            Margen
          </Typography>
          <ConnectionStatus />
        </Toolbar>
      </AppBar>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2,
          py: 8,
        }}
      >
        <Container maxWidth="sm">
          <Stack spacing={1.5} sx={{ textAlign: 'center' }}>
            <Typography variant="h3" component="h1" color="text.primary">
              A clearer view of your margins.
            </Typography>
            <Typography variant="body1" color="text.secondary">
              The workspace is ready. Your finances will appear here as the
              first features come online.
            </Typography>
          </Stack>
        </Container>
      </Box>
    </Box>
  )
}

export default App
