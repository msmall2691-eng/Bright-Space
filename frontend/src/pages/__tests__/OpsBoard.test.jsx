/**
 * OpsBoard — the iOS triage dashboard. Verifies the view logic that isn't the
 * backend's job: it mounts from one /api/dashboard/board fetch, clearing a card
 * moves the progress bar (and persists), the severity chips filter, search
 * narrows the sections, and card `actions` run inline — a plain API action
 * clears the card, a `confirm` action needs a second click before it POSTs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn() }))

import { get, post } from '../../api'
import OpsBoard from '../OpsBoard'

const PAYLOAD = {
  company: 'The Maine Cleaning Co.',
  email: 'office@mainecleaningco.com',
  refreshed_at: '2026-08-10T14:00:00Z',
  stats: [
    { key: 'unassigned', label: 'Unassigned jobs', value: '4', sub: 'next 7 days', tone: 'red', href: '/schedule' },
    { key: 'collected', label: 'Collected today', value: '$39', sub: 'payments in', tone: 'money', href: '/billing' },
  ],
  integrations: [
    { key: 'gmail', label: 'Gmail', status: 'connected', detail: '2 accounts', tone: 'green' },
  ],
  filters: { all: 4, urgent: 1, watch: 2, info: 1, good: 0, recurring: 0 },
  sections: [
    { key: 'needs_today', title: 'Needs You Today', icon: '🔴', items: [
      { id: 'job:1', severity: 'urgent', title: 'No cleaner assigned', body: 'Denmark Rental', meta: 'today',
        tags: [{ label: 'TURNO', tone: 'blue' }],
        actions: [
          { label: 'Auto-assign', kind: 'api', method: 'POST', endpoint: '/api/jobs/1/auto-assign', done: 'Assigned', clears: true },
          { label: 'Dispatch', kind: 'link', href: '/schedule?view=dispatch' },
        ] },
    ] },
    { key: 'jobs_on_deck', title: 'Jobs on Deck', icon: '🧹', items: [
      { id: 'deck-job:2', severity: 'watch', title: 'Wells rental', body: 'Jess Racco', meta: 'Sat',
        tags: [{ label: 'STR', tone: 'blue' }], actions: [{ label: 'View', kind: 'link', href: '/jobs/2' }] },
    ] },
    { key: 'money', title: 'Money', icon: '💵', items: [
      { id: 'money:outstanding', severity: 'info', title: '$250 outstanding', body: 'across 1 invoice', meta: '',
        tags: [{ label: 'AR', tone: 'amber' }], actions: [{ label: 'Chase', kind: 'link', href: '/billing' }] },
      { id: 'invoice:9', severity: 'watch', title: 'INV-9 — Acme', body: '$520 · 12d overdue', meta: '',
        tags: [{ label: 'OVERDUE', tone: 'rose' }],
        actions: [
          { label: 'Mark paid', kind: 'api', method: 'POST', endpoint: '/api/invoices/9/pay', body: {},
            confirm: 'Mark this invoice paid?', done: 'Paid', clears: true },
          { label: 'Open', kind: 'link', href: '/billing' },
        ] },
    ] },
    { key: 'people_waiting', title: 'Real People Waiting', icon: '✉️', items: [] },
    { key: 'systems', title: 'Systems & Subscriptions', icon: '🧰', items: [] },
    { key: 'safe_to_ignore', title: 'Safe to Ignore', icon: '🗑️', items: [] },
  ],
}

function renderBoard() {
  return render(<MemoryRouter><OpsBoard /></MemoryRouter>)
}

beforeEach(() => {
  localStorage.clear()
  get.mockReset(); post.mockReset()
  get.mockResolvedValue(PAYLOAD)
  post.mockResolvedValue({})
})
afterEach(cleanup)

describe('OpsBoard', () => {
  it('mounts from one board fetch and renders sections + cards', async () => {
    renderBoard()
    expect(await screen.findByText('The Maine Cleaning Co.')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/dashboard/board')
    expect(screen.getByText('No cleaner assigned')).toBeTruthy()
    expect(screen.getByText('Wells rental')).toBeTruthy()
    expect(screen.getByText('0 of 4 cleared')).toBeTruthy()
  })

  it('clearing a card advances the progress and persists', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getAllByLabelText('Clear')[0])
    expect(screen.getByText('1 of 4 cleared')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('brightbase_board_cleared'))).toContain('job:1')
  })

  // Search + severity chips fold behind the quiet "Filters" disclosure now
  // (owner: "this is so busy") — open it first, then filter as before.
  it('severity chips filter the visible cards', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.click(screen.getByRole('button', { name: /urgent/i }))
    expect(screen.getByText('No cleaner assigned')).toBeTruthy() // urgent
    expect(screen.queryByText('Wells rental')).toBeNull()        // watch → hidden
  })

  it('search narrows the board', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(screen.getByPlaceholderText(/search everything/i), { target: { value: 'wells' } })
    expect(screen.getByText('Wells rental')).toBeTruthy()
    expect(screen.queryByText('No cleaner assigned')).toBeNull()
  })

  it('runs an inline API action and clears the card', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByRole('button', { name: /auto-assign/i }))
    expect(post).toHaveBeenCalledWith('/api/jobs/1/auto-assign', {})
    expect(await screen.findByText(/Assigned — No cleaner assigned/i)).toBeTruthy()
    expect(screen.getByText('1 of 4 cleared')).toBeTruthy()
  })

  it('needs a confirm before a destructive action', async () => {
    renderBoard()
    await screen.findByText('INV-9 — Acme')
    fireEvent.click(screen.getByRole('button', { name: /^mark paid$/i }))
    expect(post).not.toHaveBeenCalled()                 // first click only asks
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/invoices/9/pay', {})
  })
})
