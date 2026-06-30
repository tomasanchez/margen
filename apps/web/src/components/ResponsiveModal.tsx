/**
 * Shared responsive modal surface (ADR-017, ADR-019, ADR-037).
 *
 * Single source of truth for how Margen presents a modal across viewports,
 * extracted from the original Add/Edit transaction presenter:
 *
 *  - desktop (md+): a centered MUI {@link Dialog} with a rounded, token-styled
 *    Paper and a configurable `maxWidth`;
 *  - mobile (md down): a bottom-anchored MUI {@link Drawer} that rises from the
 *    bottom and fills most of the viewport (`maxHeight: 92vh`), with rounded top
 *    corners, a decorative grab handle, and a scrollable body.
 *
 * Both surfaces trap focus and restore it to the trigger on close, and Escape
 * closes them (MUI built-ins) — satisfying ADR-019. The Drawer carries an
 * explicit `role="dialog"` + `aria-modal` so assistive tech (and tests) treat it
 * as a dialog like the desktop surface does.
 *
 * Two title modes:
 *  - pass {@link ResponsiveModalProps.title} and the modal renders its own header
 *    (heading + a close button) and wires `aria-labelledby` automatically;
 *  - omit `title` and pass {@link ResponsiveModalProps.titleId} instead — the
 *    children own their header (e.g. the Add/Edit form), and the modal only wires
 *    `aria-labelledby` to that id. This keeps the existing form's look intact.
 *
 * Numeric `sx` width/height values are PERCENTAGES in MUI, so explicit pixel
 * sizes are passed as strings and the sheet height uses `vh` (per the project's
 * sx-sizing gotcha).
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Dialog from '@mui/material/Dialog'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useMediaQuery, useTheme } from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'

/** Inner padding the desktop Dialog applies around content (concept used 24px). */
const DESKTOP_CONTENT_SX = { px: 3, py: 3 } as const

export interface ResponsiveModalProps {
  /** Whether the modal is open. */
  open: boolean
  /** Dismiss the modal (Escape / backdrop / close button all route here). */
  onClose: () => void
  /**
   * Heading text. When provided the modal renders its own header (title + close
   * button) and wires `aria-labelledby`. Omit it when the children render their
   * own header — then pass {@link titleId} so the surface can still be labelled.
   */
  title?: React.ReactNode
  /**
   * id of an externally-rendered heading to label the surface with. Used when
   * `title` is NOT provided (the children own the header). When `title` IS
   * provided this is ignored — the modal generates and owns the id.
   */
  titleId?: string
  /**
   * Desktop max width. Number is treated as pixels (emitted as a string to avoid
   * MUI's numeric-sx = percent gotcha). Defaults to 460px.
   */
  maxWidth?: number | string
  /** Modal body. */
  children: React.ReactNode
}

/** Coerce a numeric pixel width to a string so MUI doesn't read it as a percent. */
function asWidth(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * Render `children` inside a centered Dialog (desktop) or a bottom Drawer
 * (mobile), with consistent token styling, focus trapping, and dismissal.
 */
export function ResponsiveModal({
  open,
  onClose,
  title,
  titleId,
  maxWidth = 460,
  children,
}: ResponsiveModalProps) {
  const { t } = useTranslation('common')
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))

  // When we own the header we need our own heading id; when the children own it
  // we label the surface with the caller-supplied id.
  const ownTitleId = useId()
  const hasOwnHeader = title != null
  const labelledBy = hasOwnHeader ? ownTitleId : titleId

  // The header the modal renders for itself (title + close). Omitted when the
  // children own their header (then the body already includes a heading + close).
  const header = hasOwnHeader ? (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        mb: 2.5,
      }}
    >
      <Typography
        id={ownTitleId}
        variant="h6"
        component="h2"
        sx={{ fontSize: 18, fontWeight: 600 }}
        color="text.primary"
      >
        {title}
      </Typography>
      <IconButton
        onClick={onClose}
        aria-label={t('actions.close')}
        size="small"
        sx={{
          flex: 'none',
          border: '1px solid var(--mg-border-2)',
          borderRadius: 2,
          color: 'text.secondary',
        }}
      >
        <CloseRoundedIcon fontSize="small" />
      </IconButton>
    </Box>
  ) : null

  if (isMobile) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            // Make the Drawer paper a labelled dialog so AT + tests treat it like
            // the desktop surface (a Drawer's default role is presentation).
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': labelledBy,
            sx: {
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              bgcolor: 'var(--mg-paper-2)',
              border: '1px solid',
              borderColor: 'var(--mg-border-2)',
              maxHeight: '92vh',
              px: 2.5,
              pt: 1.5,
              pb: 'calc(env(safe-area-inset-bottom) + 24px)',
            },
          },
        }}
      >
        {/* Grab handle (decorative). */}
        <Box
          aria-hidden
          sx={{
            width: 38,
            height: 4,
            borderRadius: 3,
            bgcolor: 'var(--mg-border-2)',
            mx: 'auto',
            mb: 2,
          }}
        />
        {header}
        {children}
      </Drawer>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      aria-labelledby={labelledBy}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: asWidth(maxWidth),
            bgcolor: 'var(--mg-paper-2)',
            border: '1px solid var(--mg-border-2)',
            borderRadius: 5,
            ...DESKTOP_CONTENT_SX,
          },
        },
      }}
    >
      {header}
      {children}
    </Dialog>
  )
}

export default ResponsiveModal
