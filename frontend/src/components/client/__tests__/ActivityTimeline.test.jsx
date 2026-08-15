import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => navigateSpy }
})

import ActivityTimeline from '../ActivityTimeline'

afterEach(() => { cleanup(); navigateSpy.mockReset() })

const baseProps = {
  activityFilter: 'all', setActivityFilter: vi.fn(),
  noteText: '', setNoteText: vi.fn(), savingNote: false, submitNote: vi.fn(),
}

const renderTimeline = (allActivity) =>
  render(
    <MemoryRouter>
      <ActivityTimeline allActivity={allActivity} {...baseProps} />
    </MemoryRouter>
  )

describe('ActivityTimeline — linear connectivity', () => {
  it('opens the quote page when a quote entry is clicked (previously a dead end)', () => {
    renderTimeline([
      { type: 'quote', date: '2026-07-17', data: { id: 20, quote_number: 'Q-1', status: 'viewed', total: 450, items: [] } },
    ])
    fireEvent.click(screen.getByText(/Quote —/))
    expect(navigateSpy).toHaveBeenCalledWith('/quotes/20')
  })

  it('opens the invoice, job, and opportunity pages the same way', () => {
    renderTimeline([
      { type: 'invoice', date: '2026-07-18', data: { id: 10, invoice_number: 'INV-1', status: 'overdue', total: 300 } },
      { type: 'job', date: '2026-07-19', data: { id: 30, title: 'Biweekly clean', scheduled_date: '2026-07-25', status: 'scheduled' } },
      { type: 'opportunity', date: '2026-07-20', data: { id: 40, title: 'Deep clean lead', stage: 'new' } },
    ])
    fireEvent.click(screen.getByText('INV-1 — $300.00'))
    expect(navigateSpy).toHaveBeenCalledWith('/invoices/10')
    fireEvent.click(screen.getByText('Biweekly clean'))
    expect(navigateSpy).toHaveBeenCalledWith('/jobs/30')
    fireEvent.click(screen.getByText('Deep clean lead'))
    expect(navigateSpy).toHaveBeenCalledWith('/opportunities/40')
  })

  it('leaves entries with no detail page (notes, messages) non-clickable', () => {
    renderTimeline([
      { type: 'activity_log', date: '2026-07-21', data: { activity_type: 'note_added', summary: 'Left a gate code note', extra_data: {} } },
    ])
    const card = screen.getByText('Left a gate code note').closest('div.bg-panel')
    expect(card.className).not.toContain('cursor-pointer')
    fireEvent.click(card)
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})
