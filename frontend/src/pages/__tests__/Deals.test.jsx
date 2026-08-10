/**
 * Deals board — the unified table renders both card kinds, filters by stage,
 * and exposes the right inline action per row (Qualify for an inbox lead, a
 * stage mover for a deal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const moveStage = vi.fn()
const triageLead = vi.fn()
let hookState
vi.mock('../../hooks/useDeals', () => ({ useDeals: () => hookState }))

import Deals from '../Deals'

const lead = {
  id: 'lead-1', kind: 'lead', lead_id: 1, stage: 'inbox',
  title: 'Residential', client_name: 'Web Lead', amount: 250, age_days: 0,
  quote_status: null, job_state: null,
}
const deal = {
  id: 'deal-9', kind: 'deal', opportunity_id: 9, stage: 'qualified',
  title: 'Keystone Clean', client_name: 'Acme', amount: 500, age_days: 4,
  quote_status: 'sent', job_state: 'scheduled',
}

beforeEach(() => {
  hookState = {
    deals: [lead, deal], loading: false, error: null, busyId: null,
    reload: vi.fn(), moveStage, triageLead, setError: vi.fn(),
  }
})
afterEach(() => { cleanup(); moveStage.mockReset(); triageLead.mockReset() })

const renderBoard = () => render(<MemoryRouter><Deals /></MemoryRouter>)

describe('Deals board', () => {
  it('renders both an inbox lead and a deal row', () => {
    renderBoard()
    expect(screen.getByText('Keystone Clean')).toBeTruthy()
    expect(screen.getByText('Residential')).toBeTruthy()
  })

  it('gives an inbox lead a Qualify action wired to triageLead', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('button', { name: /Qualify/ }))
    expect(triageLead).toHaveBeenCalledTimes(1)
    expect(triageLead.mock.calls[0][0].id).toBe('lead-1')
  })

  it('gives a deal an inline stage mover wired to moveStage', () => {
    renderBoard()
    const select = screen.getByLabelText('Move deal to stage')
    fireEvent.change(select, { target: { value: 'won' } })
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ id: 'deal-9' }), 'won')
  })

  it('filters to a single stage via the chip row', () => {
    renderBoard()
    // Filter to Inbox — the deal row drops out.
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
    expect(screen.queryByText('Keystone Clean')).toBeNull()
    expect(screen.getByText('Residential')).toBeTruthy()
  })

  it('shows the enriched quote status and job state for a deal', () => {
    renderBoard()
    const row = screen.getByText('Keystone Clean').closest('tr')
    expect(within(row).getByText('sent')).toBeTruthy()
    expect(within(row).getByText('scheduled')).toBeTruthy()
  })
})
