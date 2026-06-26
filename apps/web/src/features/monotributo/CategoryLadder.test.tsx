/**
 * CategoryLadder tests (ADR-017 responsive, ADR-019 non-color cues).
 *
 * The ladder renders TWO strips in the DOM at once — a full A–K strip for `md`+
 * and a condensed anchor strip for `xs` — toggled by the `display: { xs, md }`
 * pattern. jsdom does not evaluate CSS media queries, so both are always
 * present; we pick a strip via its `data-variant` hook (`full` / `condensed`)
 * rather than relying on viewport width.
 *
 * Coverage:
 *  - the desktop strip always shows the complete A–K scale;
 *  - the condensed strip shows only the deduped anchor set (lowest · max ·
 *    current · projected), kept in A→K scale order;
 *  - the current / projected markers + accessible roles survive on the
 *    condensed cells (so the user still sees where they land);
 *  - a non-contiguous anchor set surfaces the "…" gap hint with its
 *    visually-hidden note; a contiguous one does not.
 */

import { describe, expect, test } from 'vitest'
import { within } from '@testing-library/react'
import { renderWithProviders } from '../../test/renderWithProviders'
import { CategoryLadder } from './CategoryLadder'
import type { MonotributoScaleRow } from '../../mock/types'

/** A through K, mirroring the serialized scale (compact ceilings suffice here). */
const SCALE: MonotributoScaleRow[] = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
].map((letter, index) => ({
  letter,
  annualCeiling: (index + 1) * 5_000_000,
  cuotaServicios: (index + 1) * 40_000,
  cuotaBienes: (index + 1) * 40_000,
}))

function strip(container: HTMLElement, variant: 'full' | 'condensed') {
  const el = container.querySelector(`[data-variant="${variant}"]`)
  if (!el) throw new Error(`missing ladder strip: ${variant}`)
  return el as HTMLElement
}

/** Letters of the real ladder cells (the gap "…" item has no aria-label). */
function cellLetters(scope: HTMLElement): string[] {
  return within(scope)
    .getAllByLabelText(/^Category [A-K],/)
    .map((cell) => cell.getAttribute('aria-label')!.match(/^Category ([A-K]),/)![1])
}

describe('desktop strip', () => {
  test('always renders the complete A–K ladder, in order', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={SCALE} current="C" projected="D" />,
    )
    expect(cellLetters(strip(container, 'full'))).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
    ])
  })
})

describe('condensed (mobile) strip', () => {
  test('shows only the deduped anchors — lowest, max, current, projected — in scale order', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={SCALE} current="E" projected="G" />,
    )
    // A (lowest) · E (current) · G (projected) · K (max), deduped + ordered.
    expect(cellLetters(strip(container, 'condensed'))).toEqual([
      'A', 'E', 'G', 'K',
    ])
  })

  test('dedupes when current / projected coincide with the bounds', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={SCALE} current="A" projected="K" />,
    )
    expect(cellLetters(strip(container, 'condensed'))).toEqual(['A', 'K'])
  })

  test('keeps the Now / Proj. markers and roles on the condensed cells', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={SCALE} current="E" projected="G" />,
    )
    const condensed = strip(container, 'condensed')
    // The accessible roles ride along on the condensed cells.
    expect(
      within(condensed).getByLabelText(/Category E, current category,/),
    ).toBeInTheDocument()
    expect(
      within(condensed).getByLabelText(/Category G, projected category,/),
    ).toBeInTheDocument()
    // The non-color text tags are present.
    expect(within(condensed).getByText('Now')).toBeInTheDocument()
    expect(within(condensed).getByText('Proj.')).toBeInTheDocument()
  })

  test('flags a non-contiguous anchor set with the gap note', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={SCALE} current="E" projected="G" />,
    )
    // A → E, E → G and G → K all skip letters, so the hidden note appears.
    expect(
      within(strip(container, 'condensed')).getAllByText(
        'Intermediate categories omitted on this view',
      ).length,
    ).toBeGreaterThan(0)
  })

  test('omits the gap note when the anchors are contiguous', () => {
    const contiguous: MonotributoScaleRow[] = SCALE.slice(0, 2) // A, B only
    const { container } = renderWithProviders(
      <CategoryLadder scale={contiguous} current="A" projected="B" />,
    )
    expect(
      within(strip(container, 'condensed')).queryByText(
        'Intermediate categories omitted on this view',
      ),
    ).not.toBeInTheDocument()
  })

  test('guards an empty scale (no cells, no crash)', () => {
    const { container } = renderWithProviders(
      <CategoryLadder scale={[]} current="C" projected="D" />,
    )
    expect(
      within(strip(container, 'condensed')).queryByLabelText(/^Category/),
    ).not.toBeInTheDocument()
  })
})
