import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import ClientOverview from '../ClientOverview'

afterEach(cleanup)

const baseProps = {
  client: { id: 1, name: 'Sandra Fox' },
  navigate: vi.fn(),
  setTab: vi.fn(),
  totalRevenue: 1250,
  outstanding: 300,
  invoices: [
    { id: 10, invoice_number: 'INV-1', total: 300, status: 'overdue', due_date: '2026-07-01' },
    { id: 11, invoice_number: 'INV-2', total: 200, status: 'paid' },
  ],
  quotes: [
    { id: 20, quote_number: 'Q-1', total: 450, status: 'viewed', created_at: '2026-07-18T14:00:00Z' },
    { id: 21, quote_number: 'Q-2', total: 100, status: 'accepted', created_at: '2026-07-12T14:00:00Z' },
    { id: 22, quote_number: 'Q-3', total: 160, status: 'draft', created_at: '2026-07-10T14:00:00Z' },
  ],
  opportunities: [{ id: 60, title: 'Cobb Cottage', amount: 280, stage: 'quoted' }],
  intakes: [{ id: 49, source: 'website', service_type: 'custom', created_at: '2026-07-08' }],
  upcomingJobs: [
    { id: 30, title: 'Biweekly clean', scheduled_date: '2026-07-25', address: '18 Kerryman Cir', status: 'scheduled' },
  ],
  pastJobs: [{ id: 31, scheduled_date: '2026-07-01', status: 'completed' }],
  schedules: [{ id: 40, active: true }, { id: 41, active: false }],
  properties: [{ id: 50, name: 'Home', address: '18 Kerryman Cir', property_type: 'residential' }],
  visitStats: { completed: 7 },
  allActivity: [
    { type: 'invoice', date: '2026-07-18', data: { invoice_number: 'INV-1', status: 'overdue' } },
    { type: 'quote', date: '2026-07-17', data: { quote_number: 'Q-1', status: 'viewed' } },
  ],
}

describe('ClientOverview', () => {
  it('shows the KPI strip with lifetime value, balance, visits and recurring', () => {
    render(<ClientOverview {...baseProps} />)
    expect(screen.getByText('$1,250')).toBeTruthy()   // lifetime value
    expect(screen.getByText('$300')).toBeTruthy()      // balance owed
    expect(screen.getByText('7')).toBeTruthy()         // visits done
    expect(screen.getByText('Lifetime value')).toBeTruthy()
    expect(screen.getByText('Recurring')).toBeTruthy()
  })

  it('surfaces ALL quotes including drafts (the fix — nothing hidden)', () => {
    render(<ClientOverview {...baseProps} />)
    // Every quote shows on the landing now, not just the "open" ones — a draft
    // used to be invisible here, which is why the quote couldn't be found.
    expect(screen.getByText(/Q-3 · \$160/)).toBeTruthy()   // draft, previously hidden
    expect(screen.getByText(/Q-2 · \$100/)).toBeTruthy()   // accepted
    expect(screen.getAllByText(/Q-1/).length).toBeGreaterThan(0)  // viewed (also in activity)
  })

  it('shows the deal / pipeline card with amount and stage', () => {
    render(<ClientOverview {...baseProps} />)
    expect(screen.getByText('Cobb Cottage')).toBeTruthy()
    expect(screen.getByText('$280')).toBeTruthy()
    expect(screen.getByText('quoted')).toBeTruthy()
    expect(screen.getByText('Request #49')).toBeTruthy()   // origin tie-back
  })

  it('shows all invoices (paid and unpaid), the upcoming visit and activity', () => {
    render(<ClientOverview {...baseProps} />)
    expect(screen.getByText(/INV-1 · \$300/)).toBeTruthy()
    expect(screen.getByText(/INV-2 · \$200/)).toBeTruthy()   // paid still listed
    expect(screen.getAllByText(/Biweekly clean/).length).toBeGreaterThan(0)
    expect(screen.getByText('Recent activity')).toBeTruthy()
  })

  it('deep-links via setTab when a KPI is clicked', () => {
    const setTab = vi.fn()
    render(<ClientOverview {...baseProps} setTab={setTab} />)
    fireEvent.click(screen.getByText('Lifetime value'))
    expect(setTab).toHaveBeenCalledWith('invoices')
  })

  it('cues an accepted quote to Book and routes straight into the booking flow', () => {
    const navigate = vi.fn()
    render(<ClientOverview {...baseProps} navigate={navigate} />)
    // The accepted quote (Q-2) shows a Book cue instead of a status badge...
    expect(screen.getByText('Book')).toBeTruthy()
    // ...and its row opens the quote with the booking modal already armed.
    fireEvent.click(screen.getByText(/Q-2 · \$100/))
    expect(navigate).toHaveBeenCalledWith('/quotes/21?book=1')
  })

  it('leaves a non-accepted quote as a plain link, no booking flag', () => {
    const navigate = vi.fn()
    render(<ClientOverview {...baseProps} navigate={navigate} />)
    fireEvent.click(screen.getByText(/Q-3 · \$160/))   // draft
    expect(navigate).toHaveBeenCalledWith('/quotes/22')
  })

  it('renders clean empty states when the client has nothing yet', () => {
    render(<ClientOverview {...baseProps} quotes={[]} invoices={[]} upcomingJobs={[]} pastJobs={[]} />)
    expect(screen.getByText('No quotes yet.')).toBeTruthy()
    expect(screen.getByText('No invoices yet.')).toBeTruthy()
    expect(screen.getByText('No visits yet.')).toBeTruthy()
  })
})
