/**
 * Mock signed-in user for the UI-first prototype (ADR-012).
 *
 * Auth is a NON-GOAL for the MVP, so the account menu renders this static
 * identity instead of a real session. The values preserve the concept's "VC"
 * avatar initials; a future auth integration replaces this module.
 */
export interface MockUser {
  name: string
  email: string
  /** Two-letter avatar initials shown in the top-bar trigger. */
  initials: string
}

export const MOCK_USER: MockUser = {
  name: 'Valentina Cruz',
  email: 'valentina.cruz@margen.app',
  initials: 'VC',
}
