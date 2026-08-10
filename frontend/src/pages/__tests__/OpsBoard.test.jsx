/**
 * OpsBoard — the iOS triage dashboard. Verifies the view logic that isn't the
 * backend's job: it mounts from one /api/dashboard/board fetch, clearing a card
 * moves the progress bar (and persists), the severity chips filter, and search
 * narrows the sections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn() }))

import { get } from '../../api'
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
    { key: 'twilio', label: 'Twilio', status: 'off', detail: 'not set', tone: 'gray' },
  ],
  filters: { all: 3, urgent: 1, watch: 1, info: 1, good: 0, recurring: 0 },
  sections: [
    { key: 'needs_today', title: 'Needs You Today', icon: '🔴', items: [
      { id: 'job:1', severity: 'urgent', title: 'No cleaner assigned', body: 'Denmark Rental', meta: 'today',
        tags: [{ label: 'TURNO', tone: 'blue' }], action: { label: 'Assign', href: '/schedule' }, source: 'brightbase' },
    ] },
    { key: 'jobs_on_deck', title: 'Jobs on Deck', icon: '🧹', items: [
      { id: 'deck-job:2', severity: 'watch', title: 'Wells rental', body: 'Jess Racco', meta: 'Sat',
        tags: [{ label: 'STR', tone: 'blue' }], action: null, source: 'brightbase' },
    ] },
    { key: 'money', title: 'Money', icon: '💵', items: [
      { id: 'money:outstanding', severity: 'info', title: '$250 outstanding', body: 'across 1 invoice', meta: '',
        tags: [{ label: 'AR', tone: 'amber' }], action: null, source: 'brightbase' },
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
  get.mockReset()
  get.mockResolvedValue(PAYLOAD)
})
afterEach(cleanup)

describe('OpsBoard', () => {
  it('mounts from one board fetch and renders sections + cards', async () => {
    renderBoard()
    expect(await screen.findByText('The Maine Cleaning Co.')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/dashboard/board')
    expect(screen.getByText('No cleaner assigned')).toBeTruthy()
    expect(screen.getByText('Wells rental')).toBeTruthy()
    expect(screen.getByText('0 of 3 cleared')).toBeTruthy()
  })

  it('clearing a card advances the progress and persists', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    const clears = screen.getAllByLabelText('Clear')
    fireEvent.click(clears[0])
    expect(screen.getByText('1 of 3 cleared')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('brightbase_board_cleared'))).toContain('job:1')
  })

  it('severity chips filter the visible cards', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByRole('button', { name: /urgent/i }))
    expect(screen.getByText('No cleaner assigned')).toBeTruthy() // urgent
    expect(screen.queryByText('Wells rental')).toBeNull()        // watch → hidden
  })

  it('search narrows the board', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.change(screen.getByPlaceholderText(/search everything/i), { target: { value: 'wells' } })
    expect(screen.getByText('Wells rental')).toBeTruthy()
    expect(screen.queryByText('No cleaner assigned')).toBeNull()
  })
})
