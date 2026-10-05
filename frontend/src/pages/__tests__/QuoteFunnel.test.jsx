import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, waitFor, cleanup, within } from '@testing-library/react'
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

/* ── Every number that can reach its records, does ─────────────────────────── */
describe('QuoteFunnel — click-through', () => {
  /** The <section> a Tile renders, found by its <h2> title. Scoping matters:
   *  "Requests" and "Won" each appear in three tiles (a KPI card, the funnel,
   *  a table column header), so an unscoped getByText is ambiguous by
   *  construction — which is what the first draft of these tests got wrong. */
  function tile(title) {
    return screen.getByRole('heading', { name: title, level: 2 }).closest('section')
  }

  /** href of the link whose visible text matches inside `root`, or null when
   *  that text is not a link at all. */
  function hrefIn(root, label) {
    const el = within(root).getByText(label)
    const a = el.closest('a')
    return a ? a.getAttribute('href') : null
  }

  it('sends each funnel stage to the records behind it', async () => {
    get.mockResolvedValueOnce(OK)
    render(<QuoteFunnel />)
    const f = await waitFor(() => tile('Conversion funnel · last 30 days'))
    expect(hrefIn(f, 'Requests')).toBe('/requests')
    expect(hrefIn(f, 'Sent')).toBe('/quotes?status=sent')
    expect(hrefIn(f, 'Viewed')).toBe('/quotes?status=viewed')
    // The accepted-but-not-booked set has its own route, so use it rather than
    // a ?status= that duplicates it.
    expect(hrefIn(f, 'Accepted')).toBe('/quotes/accepted')
    // "Won" in the funnel means Quote.status == 'converted' (analytics.py), NOT
    // a status called "won" — a link to ?status=won would reach nothing.
    expect(hrefIn(f, 'Won')).toBe('/quotes?status=converted')
  })

  it('sends a by-source row to those leads', async () => {
    // `?source=` only became a real filter in #1095; before that this table
    // counted leads it had no way to show you.
    get.mockResolvedValueOnce(OK)
    render(<QuoteFunnel />)
    const t = await waitFor(() => tile('By lead source'))
    expect(hrefIn(t, 'website')).toBe('/requests?source=website')
    expect(hrefIn(t, 'booking')).toBe('/requests?source=booking')
  })

  it('links the three outcomes that map to a real filter', async () => {
    get.mockResolvedValueOnce(OK)
    render(<QuoteFunnel />)
    const o = await waitFor(() => tile('Quote outcomes'))
    expect(hrefIn(o, 'Declined')).toBe('/quotes?status=declined')
    expect(hrefIn(o, 'Accepted · to schedule')).toBe('/quotes/accepted')
    expect(hrefIn(o, 'Won')).toBe('/quotes?status=converted')
  })

  it('does NOT link the three outcomes that have no filter to land on', async () => {
    // THE ASSERTION MOST LIKELY TO ROT, so it is explicit. `expired` and
    // `changes_requested` have no segment in QuotesToolbar's STATUS_SEGMENTS,
    // and `open` is three statuses at once (draft/sent/viewed) which one query
    // param cannot express. A link would land on a list whose own filter UI
    // cannot show the state you asked for — worse than no link. If the quotes
    // list later learns these states, link them and change this test on purpose.
    get.mockResolvedValueOnce(OK)
    render(<QuoteFunnel />)
    const o = await waitFor(() => tile('Quote outcomes'))
    expect(hrefIn(o, 'Expired')).toBeNull()
    expect(hrefIn(o, 'Changes requested')).toBeNull()
    expect(hrefIn(o, 'In play · awaiting reply')).toBeNull()
  })
})

/* ── Colour does one job per channel ───────────────────────────────────────── */
describe('QuoteFunnel — chart colour', () => {
  it('carries no status colour at a failing step', async () => {
    get.mockResolvedValueOnce(OK)
    const { container } = render(<QuoteFunnel />)
    await waitFor(() => screen.getByRole('heading', { name: 'Quote outcomes', level: 2 }))
    const html = container.innerHTML
    // Measured against this page's own grounds, every 500 step was under its
    // floor (amber-500 1.77:1, teal-500 2.05, emerald-500 2.09 — against 3:1
    // for a bar). None may come back.
    expect(html).not.toMatch(/bg-(amber|emerald|teal|red|rose|blue|violet)-500\b/)
    // `teal` was invented for a status job and is not in the design language's
    // vocabulary at all.
    expect(html).not.toMatch(/teal-/)
  })

  it('puts the count in ink and the state on a dot', async () => {
    get.mockResolvedValueOnce(OK)
    const { container } = render(<QuoteFunnel />)
    const o = await waitFor(() =>
      screen.getByRole('heading', { name: 'Quote outcomes', level: 2 }).closest('section'))
    // dataviz: "text wears text tokens, never the series colour". The count is
    // text, so it is ink — the hue lives on the dot beside it.
    const declined = within(o).getByText('Declined').closest('div')
    expect(declined.querySelector('.text-ink')).toBeTruthy()
    expect(declined.innerHTML).not.toMatch(/text-(emerald|amber|red|rose|teal)-/)
    // One dot per outcome row, and all six present.
    const dots = [...container.querySelectorAll('span[aria-hidden="true"].rounded-full')]
    expect(dots.length).toBeGreaterThanOrEqual(6)
  })
})

/* ── Economy ───────────────────────────────────────────────────────────────── */
describe('QuoteFunnel — one request', () => {
  it('costs exactly one fetch on mount, and does not poll', async () => {
    get.mockResolvedValue(OK)
    render(<QuoteFunnel />)
    await waitFor(() => screen.getByRole('heading', { name: 'By lead source', level: 2 }))
    expect(get).toHaveBeenCalledTimes(1)
    expect(String(get.mock.calls[0][0])).toMatch(/^\/api\/dashboard\/funnel\?days=30$/)
    // Turning numbers into links must not have turned any of them into a fetch.
    await new Promise(r => setTimeout(r, 60))
    expect(get).toHaveBeenCalledTimes(1)
  })
})
