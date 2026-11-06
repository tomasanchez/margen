/**
 * Who a new receivable item is for, when the item form is opened WITHOUT a
 * person — the transactions list's "Someone owes me this" entry point (ADR-220).
 *
 * The picker holds raw state (the typed text + the suggestion the owner picked);
 * {@link resolvePersonChoice} turns it into a discriminated {@link PersonChoice}:
 * an EXISTING person (picked, or typed with an exact case-insensitive name
 * match) or a NEW one to create on save. React-free so it is unit-testable.
 */

import type { Person } from '../../api/receivablesClient'

/** Who the new item is for: an existing person, or a new one to create. */
export type PersonChoice =
  | { kind: 'existing'; id: string; name: string }
  | { kind: 'new'; name: string }

/** The picker's raw state: the typed text + the person picked from the list. */
export interface PersonPickerState {
  text: string
  /** Set when the owner picked a suggestion (kept while the text still names them). */
  selected: Person | null
}

/** An empty picker. */
export const EMPTY_PERSON_PICKER: PersonPickerState = { text: '', selected: null }

/**
 * Resolve the picker into a {@link PersonChoice}, or null when no name is given:
 * the picked suggestion wins; otherwise an exact (trimmed, case-insensitive)
 * name match targets that person; anything else is a new person.
 */
export function resolvePersonChoice(
  state: PersonPickerState,
  people: readonly Person[],
): PersonChoice | null {
  const name = state.text.trim()
  if (!name) return null
  if (state.selected && state.selected.name.trim() === name) {
    return { kind: 'existing', id: state.selected.id, name: state.selected.name }
  }
  const wanted = name.toLocaleLowerCase()
  const match = people.find(
    (person) => person.name.trim().toLocaleLowerCase() === wanted,
  )
  if (match) return { kind: 'existing', id: match.id, name: match.name }
  return { kind: 'new', name }
}
