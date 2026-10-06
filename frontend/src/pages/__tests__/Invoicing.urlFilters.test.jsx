/**
 * The invoices list's URL contract, which had no test at all.
 *
 * `?status=` is what the dashboard's money links point AT: the AR-aging tile
 * and the KPI strip promise a set ("3 overdue") and then link here expecting
 * to land on exactly that set. The page's comment states three decisions about
 * how it consumes that param, and all three are the kind that a refactor drops
 * without anything going red:
 *
 *   1. a known status pre-filters the list;
 *   2. an UNKNOWN one is ignored, so a stale or hand-edited link cannot wedge
 *      the filter into an empty state the tabs cannot show;
 *   3. the param is stripped once consumed, so a manual tab click afterwards
 *      stays authoritative instead of being undone by the URL on re-render.
 *
 * (3) is the one worth the file on its own. Without the strip, the effect
 * re-applies the URL's status on every render that touches the params, and
 * clicking "Paid" snaps back to "Overdue" with no explanation.
 *
 * The data hooks are mocked: this is about the param, not about fetching, and
 * `useInvoicing` is where the statusFilter is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom'

const seen = []
vi.mock('../../hooks/useInvoicing', () => ({
  useInvoicing: (args) => {
    seen.push({ ...args })
    return {
      invoices: [], setInvoices: vi.fn(), clients: [], loading: false,
      clientName: () => '', clientOf: () => null, filtered: [],
      totalRevenue: 0, outstanding: 0, overdueCount: 0, overdueTotal: 0,
      aging: [], load: vi.fn(),
    }
  },
}))
vi.mock('../../hooks/useInvoicingMutations', () => ({
  useInvoicingMutations: () => ({
    saving: false, sending: false, drafting: false, deleting: false,
    chaser: null, setChaser: vi.fn(),
    save: vi.fn(), markPaid: vi.fn(), markOverdue: vi.fn(),
    deleteInvoice: vi.fn(), sendInvoice: vi.fn(), draftReminder: vi.fn(),
  }),
}))

import Invoicing from '../Invoicing'

/** Renders the live query string so the strip in (3) is observable. */
function UrlSpy() {
  const [params] = useSearchParams()
  return <div data-testid="url">{params.toString()}</div>
}

function mountAt(search) {
  return render(
    <MemoryRouter initialEntries={[`/billing${search}`]}>
      <Routes><Route path="/billing" element={<><Invoicing /><UrlSpy /></>} /></Routes>
    </MemoryRouter>,
  )
}

/** The statusFilter the page most recently handed the data hook. */
const currentFilter = () => seen[seen.length - 1]?.statusFilter

beforeEach(() => { seen.length = 0; vi.clearAllMocks() })
afterEach(cleanup)

describe('Invoicing: the ?status= contract the dashboard links depend on', () => {
  it('pre-filters to a status the tabs can actually show', async () => {
    mountAt('?view=invoices&status=overdue')
    await waitFor(() => expect(currentFilter()).toBe('overdue'))
  })

  it('ignores a status the tabs do not have, rather than filtering to nothing', async () => {
    // A stale link, a typo, or someone editing the URL. Honouring it would
    // leave the list empty with every tab reading unselected — no way back
    // except guessing that the URL did it.
    mountAt('?view=invoices&status=archived')
    await screen.findByTestId('url')
    expect(currentFilter(), 'an unknown status was applied').toBe('')
  })

  it('strips the status once consumed, so a tab click afterwards stays put', async () => {
    mountAt('?view=invoices&status=overdue')
    await waitFor(() => expect(currentFilter()).toBe('overdue'))
    await waitFor(() =>
      expect(screen.getByTestId('url').textContent, 'status stayed in the URL')
        .not.toMatch(/status=/))
    // The view is the page's own state and must survive the strip.
    expect(screen.getByTestId('url').textContent).toMatch(/view=invoices/)
  })

  it('leaves the filter alone when no status is given', async () => {
    mountAt('?view=invoices')
    await screen.findByTestId('url')
    expect(currentFilter()).toBe('')
  })

  it('strips ?new and ?client so a refresh does not reopen the editor', async () => {
    mountAt('?view=invoices&new=1&client=3')
    await waitFor(() => {
      const url = screen.getByTestId('url').textContent
      expect(url).not.toMatch(/new=/)
      expect(url).not.toMatch(/client=/)
    })
  })
})
