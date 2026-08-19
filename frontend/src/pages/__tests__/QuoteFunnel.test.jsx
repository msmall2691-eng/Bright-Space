import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Presentation-only page over one aggregate endpoint — mock the API helper the
// page imports and drive it with a realistic payload (the funnel math itself is
// unit-tested on the backend in tests/test_dashboard_funnel.py).
vi.mock('../../api', () => ({ get: vi.fn() }))

import QuoteFunnel from '../QuoteFunnel'
import { get } from '../../api'

const OK = {
  window_days: 30,
  as_of: '2026-08-10',
  funnel: [
    { key: 'requests', label: 'Requests', count: 40, value: null },
    { key: 'quoted', label: 'Quoted', count: 30, value: 9000 },
    { key: 'sent', label: 'Sent', count: 28, value: null },
    { key: 'viewed', label: 'Viewed', count: 22, value: null },
    { key: 'accepted', label: 'Accepted', count: 12, value: 3600 },
    { key: 'won', label: 'Won', count: 10, value: 3000 },
  ],
  conversion: {
    request_to_quote_pct: 75, quote_to_sent_pct: 93.3, sent_to_viewed_pct: 78.6,
    viewed_to_accepted_pct: 54.5, accepted_to_won_pct: 83.3, overall_pct: 25,
  },
  outcomes: { open: 8, changes_requested: 3, accepted: 2, won: 10, declined: 5, expired: 2 },
  timing: { time_to_quote_hours_median: 20, time_to_accept_hours_median: 5, quoted_sample: 30, accepted_sample: 12 },
  value: { quoted: 9000, accepted: 3600, won: 3000 },
  by_source: [
    { source: 'website', requests: 25, quoted: 20, won: 7, won_pct: 28 },
    { source: 'booking', requests: 15, quoted: 10, won: 3, won_pct: 20 },
  ],
}

// The page header now carries the Sales sub-nav strip (Deals / Requests /
// Quote funnel), which renders <Link>s — so the page needs a Router around it.
const render = (ui) => rtlRender(<MemoryRouter initialEntries={['/funnel']}>{ui}</MemoryRouter>)

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('QuoteFunnel', () => {
  it('renders the funnel KPIs, turnaround, and source breakdown', async () => {
    get.mockResolvedValueOnce(OK)
    render(<QuoteFunnel />)
    // KPI sub-lines are unique (raw percentages recur in the funnel bars).
    await waitFor(() => expect(screen.getByText('10 won of 40')).toBeTruthy())
    expect(screen.getByText('30 of 40 quoted')).toBeTruthy() // request→quote sub
    expect(screen.getByText('20h')).toBeTruthy()             // median time-to-quote
    expect(screen.getByText('5h')).toBeTruthy()              // median time-to-accept
    expect(screen.getByText('website')).toBeTruthy()         // by-source rows
    expect(screen.getByText('booking')).toBeTruthy()
  })

  it('shows an empty funnel state when there are no requests', async () => {
    get.mockResolvedValueOnce({
      ...OK,
      funnel: OK.funnel.map(s => ({ ...s, count: 0, value: s.value == null ? null : 0 })),
      outcomes: { open: 0, changes_requested: 0, accepted: 0, won: 0, declined: 0, expired: 0 },
      by_source: [],
    })
    render(<QuoteFunnel />)
    await waitFor(() => expect(screen.getByText('No requests in this window yet.')).toBeTruthy())
  })

  it('renders an ErrorState when the API rejects', async () => {
    get.mockRejectedValueOnce(new Error('network down'))
    render(<QuoteFunnel />)
    await waitFor(() => expect(screen.getByText(/Could not load the quote funnel/)).toBeTruthy())
  })
})
