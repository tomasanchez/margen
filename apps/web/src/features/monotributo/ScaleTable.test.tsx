/**
 * ScaleTable tests (ADR-019 non-color cues, ADR-200 best-fit tag).
 *
 * The full A–K scale table marks the current / projected / best-fit rows with a
 * text tag plus a glyph, never color alone. This focuses on the best-fit tag
 * (ADR-200): the recommended row carries the "Best fit" word tag, and best-fit
 * never clobbers an existing current/projected tag on the same row. English is
 * asserted (the suite is en-pinned). Both a desktop and a mobile row render for
 * every category (jsdom doesn't evaluate media queries), so the desktop word
 * tag is asserted via `getAllByText`.
 */

import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../test/renderWithProviders'
import { ScaleTable } from './ScaleTable'
import type { MonotributoScaleRow } from '../../mock/types'

const SCALE: MonotributoScaleRow[] = ['A', 'B', 'C', 'D', 'E'].map(
  (letter, index) => ({
    letter,
    annualCeiling: (index + 1) * 5_000_000,
    cuotaServicios: (index + 1) * 40_000,
    cuotaBienes: (index + 1) * 40_000,
  }),
)

const ARCA = 'https://www.arca.gob.ar/monotributo'

describe('ScaleTable best-fit tag (ADR-200)', () => {
  test('tags the recommended row with the "Best fit" word', () => {
    renderWithProviders(
      <ScaleTable
        scale={SCALE}
        current="C"
        projected="D"
        recommended="B"
        effectiveFrom="2026-02-01"
        nextReview="2026-08-01"
        arcaUrl={ARCA}
      />,
    )
    // The best-fit word tag renders (desktop chip + mobile short tag exist).
    expect(screen.getAllByText('Best fit').length).toBeGreaterThan(0)
    // The existing current / projected tags are untouched.
    expect(screen.getAllByText('Current').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Projected').length).toBeGreaterThan(0)
  })

  test('does not tag any row best-fit when no recommendation is given', () => {
    renderWithProviders(
      <ScaleTable
        scale={SCALE}
        current="C"
        projected="D"
        effectiveFrom="2026-02-01"
        nextReview="2026-08-01"
        arcaUrl={ARCA}
      />,
    )
    expect(screen.queryByText('Best fit')).not.toBeInTheDocument()
  })

  test('best-fit never clobbers the current tag when they coincide', () => {
    renderWithProviders(
      <ScaleTable
        scale={SCALE}
        current="C"
        projected="D"
        recommended="C"
        effectiveFrom="2026-02-01"
        nextReview="2026-08-01"
        arcaUrl={ARCA}
      />,
    )
    // The recommended row is already the current row, so it keeps "Current" and
    // no separate "Best fit" tag appears (the existing marker wins).
    expect(screen.getAllByText('Current').length).toBeGreaterThan(0)
    expect(screen.queryByText('Best fit')).not.toBeInTheDocument()
  })
})

describe('ScaleTable subtitle (data-driven vintage dates)', () => {
  test('renders the effective + next-review dates from the data, not hardcoded', () => {
    renderWithProviders(
      <ScaleTable
        scale={SCALE}
        current="C"
        projected="D"
        effectiveFrom="2026-02-01"
        nextReview="2026-08-01"
        arcaUrl={ARCA}
      />,
    )
    // en-pinned suite → localizedIsoDate("2026-02-01") = "Feb 1, 2026" and
    // "2026-08-01" = "Aug 1, 2026". Both dates flow through the interpolated
    // subtitle (asserted as substrings of the one subtitle line).
    expect(screen.getByText(/in effect since Feb 1, 2026/)).toBeInTheDocument()
    expect(screen.getByText(/next review Aug 1, 2026/)).toBeInTheDocument()
    // The old hardcoded copy is gone.
    expect(screen.queryByText(/August 1, 2026 · next review/)).not.toBeInTheDocument()
  })
})
