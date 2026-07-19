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
    { id: 20, quote_number: 'Q-1', total: 450, status: 'viewed', viewed_at: '2026-07-18T14:00:00Z' },
    { id: 21, quote_number: 'Q-2', total: 100, status: 'accepted' },
  ],
  upcomingJobs: [
    { id: 30, title: 'Biweekly clean', scheduled_date: '2026-07-25', address: '18 Kerryman Cir' },
  ],
  pastJobs: [{ id: 31 }, { id: 32 }],
  schedules: [{ id: 40, active: true }, { id: 41, active: false }],
  properties: [{ id: 50, name: 'Home', address: '18 Kerryman Cir' }],
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

  it('surfaces only OPEN quotes and UNPAID invoices under needs-attention', () => {
    render(<ClientOverview {...baseProps} />)
    // Open (viewed) quote and overdue invoice appear; accepted quote / paid invoice do not.
    // (Q-1 / INV-1 also show in the recent-activity feed, hence getAllByText.)
    expect(screen.getAllByText(/Quote Q-1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Invoice INV-1/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Quote Q-2/)).toBeNull()
    expect(screen.queryByText(/Invoice INV-2/)).toBeNull()
    expect(screen.getByText('Opened — awaiting reply')).toBeTruthy()
  })

  it('shows the next upcoming visit and recent activity', () => {
    render(<ClientOverview {...baseProps} />)
    expect(screen.getAllByText(/Biweekly clean/).length).toBeGreaterThan(0)
    expect(screen.getByText('Recent activity')).toBeTruthy()
  })

  it('deep-links via setTab when a KPI is clicked', () => {
    const setTab = vi.fn()
    render(<ClientOverview {...baseProps} setTab={setTab} />)
    fireEvent.click(screen.getByText('Lifetime value'))
    expect(setTab).toHaveBeenCalledWith('invoices')
  })

  it('shows an all-caught-up state when nothing is open', () => {
    render(<ClientOverview {...baseProps} quotes={[]} invoices={[]} />)
    expect(screen.getByText(/All caught up/)).toBeTruthy()
  })
})
