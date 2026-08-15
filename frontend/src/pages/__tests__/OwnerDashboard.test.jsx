/**
 * OwnerDashboard renders the six metrics from /api/dashboard/owner without
 * crashing on any of the shapes the endpoint can plausibly return: empty
 * dataset, unknown service_type values, MRR with unpriced schedules, empty
 * AR aging, and a network error.
 *
 * The page is presentation-only over one API response, so these are shape
 * regression tests — the aggregation math itself is unit-tested on the
 * backend (test_dashboard_owner.py).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(),
}))

import OwnerDashboard from '../OwnerDashboard'
import { get } from '../../api'

// The page now calls useNavigate (linked AR buckets + widget tile actions),
// so it needs a Router around it.
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)

// Benign defaults for the analytics-widget fetches the page fires alongside
// /api/dashboard/owner — each widget's own rendering is covered separately in
// components/dashboard/__tests__/OwnerWidgets.test.jsx.
const WIDGET_DEFAULTS = {
  '/api/dashboard/property-economics': { window_days: 90, properties_total: 0, properties: [] },
  '/api/dashboard/week-capacity': {
    booked_hours: 0, available_hours: 0, utilization_pct: null,
    crew_count: 0, crew_without_pattern: 0, days: [],
  },
  '/api/jobs/sync-overview': { channels: [] },
  '/api/recurring/cleanup/health': { scanned: 0, healthy: 0, issues: [] },
}

/** get() mock: `owner` (a value to resolve, or an Error to reject) for
 *  /api/dashboard/owner; quiet defaults for every widget endpoint. */
function mockGet(owner) {
  get.mockImplementation((url) => {
    if (url === '/api/dashboard/owner') {
      return owner instanceof Error ? Promise.reject(owner) : Promise.resolve(owner)
    }
    const key = Object.keys(WIDGET_DEFAULTS).find(k => url.startsWith(k))
    if (key) return Promise.resolve(WIDGET_DEFAULTS[key])
    if (url.startsWith('/api/payroll/summary')) return Promise.resolve({ employees: [] })
    return Promise.resolve({})
  })
}

const OK = {
  as_of: '2026-07-08',
  window_days: 90,
  close_rate: { quotes_sent: 20, quotes_won: 8, rate_pct: 40.0 },
  mrr: { estimate_cents: 245000, schedules_priced: 5, schedules_unpriced: 2 },
  revenue_by_service: [
    { service_type: 'residential', invoice_count: 8, total: 1600.0 },
    { service_type: 'str_turnover', invoice_count: 4, total: 900.0 },
    { service_type: 'weird_new_service', invoice_count: 1, total: 200.0 },
  ],
  ar_aging: {
    current:   { count: 4, total: 2000.0 },
    '0_30':    { count: 3, total: 750.0 },
    '31_60':   { count: 1, total: 300.0 },
    '61_90':   { count: 0, total: 0.0 },
    '90_plus': { count: 2, total: 800.0 },
    unbucketed:{ count: 1, total: 100.0 },
  },
  top_clients: [
    { client_id: 101, client_name: 'Alpha Rentals', invoice_count: 3, total: 1200.0 },
    { client_id: 102, client_name: 'Beta Airbnb',   invoice_count: 2, total: 800.0 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('OwnerDashboard', () => {
  it('renders all six sections with populated data', async () => {
    mockGet(OK)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText('40%')).toBeTruthy())
    // Close rate
    expect(screen.getByText('8 of 20 sent')).toBeTruthy()
    // MRR
    expect(screen.getByText('$2,450')).toBeTruthy()
    expect(screen.getByText(/5 priced/)).toBeTruthy()
    expect(screen.getByText(/2 unpriced/)).toBeTruthy()
    // Revenue paid
    expect(screen.getByText('$2,700')).toBeTruthy()
    // Past-due total in tile title: 750 + 300 + 0 + 800 = 1,850. `current`
    // (not yet due) and `unbucketed` (missing date) don't count toward the
    // past-due headline.
    expect(screen.getByText(/1,850 past due/)).toBeTruthy()
    // Current receivables surface on their own row, not lumped with missing-date.
    expect(screen.getByText(/Current \(not yet due\)/)).toBeTruthy()
    // Top clients
    expect(screen.getByText('Alpha Rentals')).toBeTruthy()
    expect(screen.getByText('Beta Airbnb')).toBeTruthy()
  })

  it('formats unknown service_types by Start Case fallback', async () => {
    mockGet(OK)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText('Residential')).toBeTruthy())
    expect(screen.getByText('STR turnover')).toBeTruthy()
    // Unknown key → Start Case
    expect(screen.getByText('Weird New Service')).toBeTruthy()
  })

  it('hides the "Missing due date" line when no unbucketed invoices', async () => {
    const payload = { ...OK, ar_aging: { ...OK.ar_aging, unbucketed: { count: 0, total: 0.0 } } }
    mockGet(payload)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText(/1,850 past due/)).toBeTruthy())
    expect(screen.queryByText('Missing due date')).toBeNull()
  })

  it('hides the "Current" row when there are no current receivables', async () => {
    const payload = { ...OK, ar_aging: { ...OK.ar_aging, current: { count: 0, total: 0.0 } } }
    mockGet(payload)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText(/1,850 past due/)).toBeTruthy())
    expect(screen.queryByText(/Current \(not yet due\)/)).toBeNull()
  })

  it('shows an empty state when there are no paid invoices in the window', async () => {
    const payload = { ...OK, revenue_by_service: [] }
    mockGet(payload)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText(/No paid invoices in the window yet/)).toBeTruthy())
  })

  it('renders an ErrorState when the API rejects', async () => {
    mockGet(new Error('network down'))
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText(/Could not load Owner Dashboard/)).toBeTruthy())
  })

  it('handles a null close_rate.rate_pct (no sent quotes yet) without crashing', async () => {
    const payload = {
      ...OK,
      close_rate: { quotes_sent: 0, quotes_won: 0, rate_pct: null },
    }
    mockGet(payload)
    render(<OwnerDashboard />)
    await waitFor(() => expect(screen.getByText('n/a')).toBeTruthy())
    expect(screen.getByText('0 of 0 sent')).toBeTruthy()
  })
})
