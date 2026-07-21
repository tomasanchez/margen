/**
 * "Best category for you" — the cheapest Monotributo category that covers the
 * user's typical monthly spend (ADR-200).
 *
 * Reads the standing's `recommendation` (see {@link MonotributoRecommendation}).
 * `typicalMonthlyExpenses` is the trailing-3-month MEDIAN of monthly spend (not a
 * mean), so the copy says "typical monthly spend". Three calm states (ADR-037),
 * all conveyed by words alone (ADR-019 — no color-only meaning):
 *  - a fitting recommendation → a plain sentence naming the category, its fee,
 *    and the fee as a share of what you'd invoice;
 *  - `aboveScale` → the needed invoicing is beyond the top category, so we point
 *    the user to the régimen general instead;
 *  - null (no expense history) → a calm nudge to add a few expenses.
 *
 * When the median rests on fewer than 3 months (`baselineMonths < 3`) we add a
 * calm low-confidence caption below the sentence; at 3 months we show a subtle
 * "based on 3 months" note. Both are pluralized via i18next `_one`/`_other`.
 *
 * Money is es-AR formatted via {@link formatCurrency} (ADR-102); the tax rate is
 * a 2dp percentage the backend already computed.
 */

import { Trans, useTranslation } from 'react-i18next'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { monoFontFamily } from '../../theme'
import { formatCurrency } from '../../lib/format'
import { activeIntlLocale } from '../../i18n/locale'
import type { MonotributoRecommendation } from '../../mock/types'
import { SectionCard } from '../../components/SectionCard'

export interface BestCategoryProps {
  recommendation: MonotributoRecommendation | null
}

export function BestCategory({ recommendation }: BestCategoryProps) {
  const { t } = useTranslation('monotributo')

  // The rate is a 2dp percentage the backend already computed (e.g. 4.83),
  // localized so the decimal separator tracks the UI language (ADR-102).
  const rate =
    recommendation != null
      ? new Intl.NumberFormat(activeIntlLocale(), {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(recommendation.effectiveTaxRatePct)
      : ''

  // The median-baseline caveat: a calm low-confidence line while the median rests
  // on fewer than 3 months, or a subtle "based on N months" note at 3. Pluralized
  // via i18next `_one`/`_other` off `count`. Only shown for a real (non-null,
  // non-aboveScale) recommendation — the empty/aboveScale states carry their own copy.
  const showBaselineNote =
    recommendation != null && !recommendation.aboveScale
  const baselineNoteKey =
    recommendation != null && recommendation.baselineMonths < 3
      ? 'bestCategory.baselineEarly'
      : 'bestCategory.baselineSettled'

  return (
    <SectionCard title={t('bestCategory.title')}>
      <Typography
        component="p"
        sx={{ fontSize: 13.5, lineHeight: 1.6, textWrap: 'pretty', maxWidth: 620 }}
        color="text.secondary"
      >
        {recommendation == null ? (
          t('bestCategory.empty')
        ) : recommendation.aboveScale ? (
          t('bestCategory.aboveScale', {
            typicalMonthlyExpenses: formatCurrency(
              recommendation.typicalMonthlyExpenses,
              'ARS',
            ),
            neededAnnualInvoicing: formatCurrency(
              recommendation.neededAnnualInvoicing,
              'ARS',
            ),
          })
        ) : (
          <Trans
            t={t}
            i18nKey="bestCategory.body"
            values={{
              typicalMonthlyExpenses: formatCurrency(
                recommendation.typicalMonthlyExpenses,
                'ARS',
              ),
              neededAnnualInvoicing: formatCurrency(
                recommendation.neededAnnualInvoicing,
                'ARS',
              ),
              category: recommendation.category,
              monthlyFee: formatCurrency(recommendation.monthlyFee, 'ARS'),
              annualFee: formatCurrency(recommendation.annualFee, 'ARS'),
              rate,
            }}
            components={{
              category: (
                <Box
                  component="span"
                  sx={{ color: 'var(--mg-text-mid)', fontWeight: 600 }}
                />
              ),
              fee: (
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    color: 'var(--mg-text-mid)',
                  }}
                />
              ),
              rate: (
                <Box
                  component="span"
                  sx={{
                    fontFamily: monoFontFamily,
                    color: 'var(--mg-text-mid)',
                  }}
                />
              ),
            }}
          />
        )}
      </Typography>
      {showBaselineNote && recommendation != null ? (
        <Typography
          component="p"
          sx={{ mt: 0.75, fontSize: 12, lineHeight: 1.5, textWrap: 'pretty', maxWidth: 620 }}
          color="text.secondary"
        >
          {t(baselineNoteKey, { count: recommendation.baselineMonths })}
        </Typography>
      ) : null}
    </SectionCard>
  )
}

export default BestCategory
