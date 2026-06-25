/**
 * Invoice drilldown — "The N invoices behind this" (ADR-017, ADR-023).
 *
 * The fiscal-period invoices, oldest-first, with the running cumulative building
 * toward the annual total. Desktop renders a 4-column grid (Date / Client +FX /
 * Amount / Cumulative + a tiny cumulative bar); mobile collapses to a compact
 * row (date · client + cumulative · amount). A header link drills into the full
 * Transactions screen. Amounts use the shared <Amount> for sign-aware mono money.
 */

import { useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { Link } from '@tanstack/react-router'
import { Amount } from '../../components/Amount'
import { FxBadge } from '../../components/FxBadge'
import { monoFontFamily } from '../../theme'
import { formatCurrency, formatDispDate } from '../../lib/format'
import type { MonotributoInvoice } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

const GRID_COLUMNS = '54px minmax(0, 1fr) 116px 124px'

export interface InvoiceDrilldownProps {
  invoices: MonotributoInvoice[]
  /** Annual limit, used to scale the tiny cumulative bars. */
  annualLimit: number
  /** Total counted (final cumulative), shown in the footer. */
  total: number
}

export function InvoiceDrilldown({
  invoices,
  annualLimit,
  total,
}: InvoiceDrilldownProps) {
  const { t } = useTranslation('monotributo')
  const count = invoices.length

  return (
    <SectionCard
      title={t('invoices.title', { n: count })}
      subtitle={t('invoices.subtitle')}
      action={
        <Box
          component={Link}
          to="/transactions"
          sx={{
            fontSize: 13,
            color: 'primary.main',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            borderRadius: 1,
            '&:hover': { textDecoration: 'underline', textUnderlineOffset: 2 },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          {t('invoices.openInTransactions')}
        </Box>
      }
    >
      {/* Desktop table header. */}
      <Box
        aria-hidden
        sx={{
          display: { xs: 'none', md: 'grid' },
          gridTemplateColumns: GRID_COLUMNS,
          gap: 1.5,
          px: 0.25,
          pb: 1.125,
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--mg-text-3)',
          borderBottom: '1px solid var(--mg-border)',
        }}
      >
        <Box>{t('invoices.header.date')}</Box>
        <Box>{t('invoices.header.client')}</Box>
        <Box sx={{ textAlign: 'right' }}>{t('invoices.header.amount')}</Box>
        <Box sx={{ textAlign: 'right' }}>{t('invoices.header.cumulative')}</Box>
      </Box>

      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {invoices.map((iv) => {
          const cumPct = Math.min((iv.cumulative / annualLimit) * 100, 100)
          return (
            <Box
              component="li"
              key={iv.id}
              sx={{ borderBottom: '1px solid var(--mg-border)' }}
            >
              {/* Desktop row. */}
              <Box
                sx={{
                  display: { xs: 'none', md: 'grid' },
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: 1.5,
                  alignItems: 'center',
                  py: 1.375,
                  px: 0.25,
                }}
              >
                <Typography
                  sx={{ fontFamily: monoFontFamily, fontSize: 12 }}
                  color="text.disabled"
                >
                  {formatDispDate(iv.dispDate)}
                </Typography>
                <Box sx={{ minWidth: 0 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.875,
                      minWidth: 0,
                    }}
                  >
                    <Typography
                      sx={{
                        fontSize: 13.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      color="text.primary"
                    >
                      {iv.client}
                    </Typography>
                    {iv.fx ? <FxBadge /> : null}
                  </Box>
                  <Typography
                    sx={{
                      fontFamily: monoFontFamily,
                      fontSize: 11,
                      mt: 0.25,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    color="text.disabled"
                  >
                    {iv.note}
                  </Typography>
                </Box>
                <Box sx={{ justifySelf: 'end' }}>
                  <Amount value={iv.amountNum} type="income" size="sm" />
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography
                    sx={{
                      fontFamily: monoFontFamily,
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 12.5,
                      whiteSpace: 'nowrap',
                    }}
                    color="var(--mg-text-mid)"
                  >
                    {formatCurrency(iv.cumulative, 'ARS')}
                  </Typography>
                  <Box
                    aria-hidden
                    sx={{
                      height: 4,
                      mt: 0.625,
                      borderRadius: '3px',
                      overflow: 'hidden',
                      bgcolor: 'var(--mg-raised)',
                    }}
                  >
                    <Box
                      sx={{
                        height: '100%',
                        width: `${cumPct}%`,
                        borderRadius: '3px',
                        backgroundImage:
                          'linear-gradient(90deg, var(--mg-gold), var(--mg-gold-hover))',
                      }}
                    />
                  </Box>
                </Box>
              </Box>

              {/* Mobile row. */}
              <Box
                sx={{
                  display: { xs: 'flex', md: 'none' },
                  alignItems: 'center',
                  gap: 1.375,
                  py: 1.25,
                  px: 0.25,
                }}
              >
                <Typography
                  sx={{
                    fontFamily: monoFontFamily,
                    fontSize: 11,
                    width: 46,
                    flex: 'none',
                  }}
                  color="text.disabled"
                >
                  {formatDispDate(iv.dispDate)}
                </Typography>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box
                    sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}
                  >
                    <Typography
                      sx={{
                        fontSize: 13,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      color="text.primary"
                    >
                      {iv.client}
                    </Typography>
                    {iv.fx ? <FxBadge /> : null}
                  </Box>
                  <Typography
                    sx={{ fontFamily: monoFontFamily, fontSize: 10.5, mt: 0.25 }}
                    color="text.disabled"
                  >
                    {t('invoices.cumulativeShort', {
                      amount: formatCurrency(iv.cumulative, 'ARS'),
                    })}
                  </Typography>
                </Box>
                <Amount value={iv.amountNum} type="income" size="sm" />
              </Box>
            </Box>
          )
        })}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 1.5,
          mt: 1.875,
          flexWrap: 'wrap',
        }}
      >
        <Typography sx={{ fontSize: 12.5 }} color="text.secondary">
          {t('invoices.footerCount', { n: count })}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography sx={{ fontSize: 12.5 }} color="text.disabled">
            {t('invoices.totalCounted')}
          </Typography>
          <Typography
            sx={{
              fontFamily: monoFontFamily,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 15,
              fontWeight: 600,
            }}
            color="text.primary"
          >
            {formatCurrency(total, 'ARS')}
          </Typography>
        </Box>
      </Box>
    </SectionCard>
  )
}

export default InvoiceDrilldown
