/**
 * Flow — the lead→cash pipeline as one prioritized list.
 *
 * Pins the contract the owner asked for: the stages render top-to-bottom, each
 * row shows its next action, and tapping a row navigates to that next step
 * (the "Book it" link goes to the quote's booking flow, which no longer
 * dead-ends). An empty pipeline says so rather than showing empty furniture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mockNav = vi.fn()
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => mockNav }
})

const get = vi.fn()
const del = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({
  get: (...a) => get(...a), del: (...a) => del(...a), post: (...a) => post(...a),
}))
const toastSuccess = vi.fn()
vi.mock('../../utils/toastBus', () => ({
  toast: { success: (...a) => toastSuccess(...a), error: vi.fn(), info: vi.fn() },
}))

import Flow from '../Flow'

const PAYLOAD = {
  total_open: 3,
  stages: [
    {
      key: 'accepted', label: 'Ready to book', tone: 'amber', count: 2,
      items: [
        { id: 'accepted:12', severity: 'watch', title: 'Jane Cove',
          body: '$633.00 · accepted, not booked', meta: '3d ago', tags: [],
          actions: [
            { label: 'Book it', kind: 'link', href: '/quotes/12?book=1' },
            { label: 'Archive', kind: 'api', method: 'DELETE', endpoint: '/api/quotes/12',
              confirm: 'Archive this quote? You can restore it later.', done: 'Archived' },
          ] },
        { id: 'accepted:13', severity: 'watch', title: 'Bob Pier',
          body: '$200.00 · accepted, not booked', meta: '1w ago', tags: [],
          actions: [{ label: 'Book it', kind: 'link', href: '/quotes/13?book=1' }] },
      ],
    },
    {
      key: 'booked', label: 'Booked', tone: 'emerald', count: 1,
      items: [
        { id: 'job:5', severity: 'watch', title: 'Casey Reed', body: '9 Dock Ln',
          meta: 'Fri · 10–1p', tags: [{ label: 'Needs cleaner', tone: 'amber' }],
          actions: [{ label: 'Open job', kind: 'link', href: '/jobs/5' }] },
      ],
    },
  ],
}

const renderFlow = () => render(<MemoryRouter initialEntries={['/flow']}><Flow /></MemoryRouter>)

beforeEach(() => { get.mockReset(); mockNav.mockReset(); del.mockReset(); post.mockReset(); toastSuccess.mockReset() })
afterEach(cleanup)

describe('Flow pipeline list', () => {
  it('renders each stage with its rows and next action', async () => {
    get.mockResolvedValue(PAYLOAD)
    renderFlow()
    expect(await screen.findByText('Ready to book')).toBeTruthy()
    expect(screen.getByText('Booked')).toBeTruthy()
    expect(screen.getByText('Jane Cove')).toBeTruthy()
    expect(screen.getAllByText('Book it').length).toBe(2)
    expect(screen.getByText('Needs cleaner')).toBeTruthy()
  })

  it('navigates to the next step when a row action is tapped', async () => {
    get.mockResolvedValue(PAYLOAD)
    renderFlow()
    const book = (await screen.findAllByText('Book it'))[0]
    fireEvent.click(book)
    expect(mockNav).toHaveBeenCalledWith('/quotes/12?book=1')
  })

  it('archives a quote in place after a confirm — no bounce, row disappears', async () => {
    get.mockResolvedValue(PAYLOAD)
    del.mockResolvedValue({ status: 'archived', id: 12 })
    renderFlow()
    await screen.findByText('Jane Cove')
    const archive = screen.getByText('Archive')
    fireEvent.click(archive)                       // first tap arms the confirm
    expect(del).not.toHaveBeenCalled()
    expect(await screen.findByText('Confirm?')).toBeTruthy()
    fireEvent.click(screen.getByText('Confirm?'))  // second tap does it
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/quotes/12'))
    await waitFor(() => expect(screen.queryByText('Jane Cove')).toBeNull())
    expect(toastSuccess).toHaveBeenCalledWith('Archived')
    expect(mockNav).not.toHaveBeenCalled()         // archiving never navigates
  })

  it('shows an empty state when the pipeline is clear', async () => {
    get.mockResolvedValue({ stages: [], total_open: 0 })
    renderFlow()
    expect(await screen.findByText(/Nothing in the pipeline/i)).toBeTruthy()
  })
})
