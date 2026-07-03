/**
 * <CollapsibleSection> — a {@link SectionCard} whose body can be collapsed
 * (ADR-019), with the open/closed choice remembered PER DEVICE.
 *
 * A thin composition over {@link SectionCard}'s opt-in collapsible mode: it owns
 * the persisted collapsed state via {@link useSectionCollapsed} (localStorage,
 * SSR/private-mode safe, default EXPANDED) and supplies the accessible toggle
 * label ("Collapse {section}" / "Expand {section}", ADR-019) so every collapsible
 * section on the page shares ONE implementation. Future sections adopt it by
 * rendering this instead of {@link SectionCard} — no per-section wiring.
 *
 * The header title becomes the disclosure button (a real `<button>` with
 * `aria-expanded` + `aria-controls`, keyboard operable, decorative chevron); the
 * existing header `action` slot (e.g. an "Add" button) stays clickable WITHOUT
 * toggling collapse — the action lives in its own header cell, outside the toggle
 * button, so a click there never bubbles to the toggle.
 */

import { useTranslation } from 'react-i18next'
import { SectionCard, type SectionCardProps } from './SectionCard'
import { useSectionCollapsed } from './useSectionCollapsed'

export interface CollapsibleSectionProps
  extends Omit<
    SectionCardProps,
    'collapsible' | 'collapsed' | 'onToggleCollapsed' | 'toggleAriaLabel'
  > {
  /**
   * Stable key for persisting this section's collapsed state, keyed as
   * `margen.accounts.section.<storageKey>.collapsed`. Must be unique per section.
   */
  storageKey: string
  /**
   * Plain-text section name used in the toggle's accessible label
   * ("Collapse {name}" / "Expand {name}"). Defaults to `title` when it is a
   * string; pass explicitly when `title` is a non-string node.
   */
  sectionLabel?: string
}

/** A SectionCard with a persisted, accessible collapse/expand disclosure. */
export function CollapsibleSection({
  storageKey,
  sectionLabel,
  title,
  ...rest
}: CollapsibleSectionProps) {
  const { t } = useTranslation('common')
  const { collapsed, toggle } = useSectionCollapsed(storageKey)

  const label =
    sectionLabel ?? (typeof title === 'string' ? title : storageKey)
  const toggleAriaLabel = collapsed
    ? t('collapsible.expand', { section: label })
    : t('collapsible.collapse', { section: label })

  return (
    <SectionCard
      {...rest}
      title={title}
      collapsible
      collapsed={collapsed}
      onToggleCollapsed={toggle}
      toggleAriaLabel={toggleAriaLabel}
    />
  )
}

export default CollapsibleSection
