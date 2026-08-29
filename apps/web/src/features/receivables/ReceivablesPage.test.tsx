/**
 * Unit test for the dedicated Receivables page (ADR-208 amendment).
 *
 * The page was promoted from a section on the Accounts page to its own route +
 * "Owed" nav tab. This asserts the route host renders its <h1> landmark and the
 * self-contained {@link ReceivablesSection} (people list) beneath it. The network
 * boundary ({@link receivablesClient}) is mocked so the real TanStack Query hooks
 * run; the domain CRUD behavior itself is covered by ReceivablesSection.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ColorModeProvider } from '../../theme/colorMode'
import { ReceivablesPage } from './ReceivablesPage'
import { receivablesClient, type Person } from '../../api/receivablesClient'

vi.mock('../../api/receivablesClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/receivablesClient')>()
  return {
    ...actual,
    receivablesClient: {
      listPeople: vi.fn(),
      getPerson: vi.fn(),
      createPerson: vi.fn(),
      renamePerson: vi.fn(),
      deletePerson: vi.fn(),
      addItem: vi.fn(),
      editItem: vi.fn(),
      deleteItem: vi.fn(),
      recordPayment: vi.fn(),
      matchSuggestions: vi.fn(),
      confirmMatch: vi.fn(),
      downloadPersonPdf: vi.fn(),
    },
  }
})

const mockListPeople = vi.mocked(receivablesClient.listPeople)

const PEOPLE: Person[] = [{ id: 'p1', name: 'Ana', outstanding: '500000.00' }]

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <ReceivablesPage />
      </ColorModeProvider>
    </QueryClientProvider>,
  )
}

describe('ReceivablesPage', () => {
  beforeEach(() => {
    mockListPeople.mockResolvedValue(PEOPLE)
  })
  afterEach(() => vi.clearAllMocks())

  test('renders the page <h1> landmark', () => {
    renderPage()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Money owed to me' }),
    ).toBeInTheDocument()
  })

  test('hosts the receivables section (people list)', async () => {
    renderPage()
    // The section loads the people list from the mocked client, proving the
    // route body wires the real ReceivablesSection (not a stub).
    expect(await screen.findByText('Ana')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add person' }),
    ).toBeInTheDocument()
  })
})
