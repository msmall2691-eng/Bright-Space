/**
 * Quoting — the status filter lives in the URL.
 *
 * `?tab=` was already honoured; the status filter was not URL-backed at all,
 * so the Quote funnel's outcome rows had nowhere to link and a filtered list
 * did not survive a reload.
 *
 * The delicate part is `/quotes/accepted`. That route exists to BE the
 * accepted-quotes list, and its original comment promised it applies the filter
 * "on entry without fighting the user if they then change the status dropdown".
 * With status in the URL that promise becomes explicit and testable: the
 * default is applied only when the URL carries no `?status=` of its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../components/SavedViewsBar', () => ({ default: () => null }))
vi.mock('../../components/quoting/QuoteEditPanel', () => ({ default: () => null }))
vi.mock('../../components/quoting/SendQuotePanel', () => ({ default: () => null }))
vi.mock('../../components/quoting/TemplateManagerModal', () => ({ default: () => null }))

import Quoting from '../Quoting'

const QUOTES = [
  { id: 1, quote_number: 'Q-1', status: 'sent', total: 100, items: [], client_id: 1, created_at: '2026-10-01T10:00:00Z' },
  { id: 2, quote_number: 'Q-2', status: 'declined', total: 200, items: [], client_id: 2, created_at: '2026-10-02T10:00:00Z' },
  { id: 3, quote_number: 'Q-3', status: 'accepted', total: 300, items: [], client_id: 3, created_at: '2026-10-03T10:00:00Z' },
]

function stubFetch() {
  global.fetch = vi.fn((url) => {
    const u = String(url)
    const body =
      u.includes('/api/quotes/follow-ups') ? []
      : u.includes('/api/quotes') ? QUOTES
      : u.includes('/api/clients') ? []
      : u.includes('/api/intake') ? []
      : u.includes('/api/settings') ? {}
      : []
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') })
  })
}

function draw(url) {
  return render(<MemoryRouter initialEntries={[url]}><Quoting /></MemoryRouter>)
}

/** The label of the selected status tab — the toolbar renders a real
 *  role="tablist" with aria-selected, so this reads what a user would see. */
async function selectedStatus() {
  const list = await screen.findByRole('tablist', { name: 'Filter by status' })
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  const active = tabs.find(t => t.getAttribute('aria-selected') === 'true')
  // Strip the trailing count the segment appends.
  return active ? active.textContent.replace(/\d+$/, '').trim() : null
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  stubFetch()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals?.() })

describe('Quoting — status from the URL', () => {
  it('applies ?status= on arrival', async () => {
    draw('/quotes?status=declined')
    await waitFor(async () => expect(await selectedStatus()).toBe('Declined'))
  })

  it('leaves status unset for a bare /quotes', async () => {
    draw('/quotes')
    await waitFor(async () => expect(await selectedStatus()).toBe('All'))
  })

  it('/quotes/accepted still defaults to accepted', async () => {
    draw('/quotes/accepted')
    await waitFor(async () => expect(await selectedStatus()).toBe('Accepted'))
  })

  it('/quotes/accepted does NOT fight an explicit ?status=', async () => {
    // The promise the original comment made, now enforceable: arriving at the
    // accepted route with a status already in the URL respects it.
    draw('/quotes/accepted?status=sent')
    await waitFor(async () => expect(await selectedStatus()).toBe('Sent'))
  })

  it('renders without crashing on a nonsense status', async () => {
    draw('/quotes?status=not-a-real-status')
    // The page must not blow up on a hand-edited URL; the list simply matches
    // nothing rather than throwing. The toolbar rendering is the proof — and
    // no segment claims to be selected, because none of them is that value.
    const list = await screen.findByRole('tablist', { name: 'Filter by status' })
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    expect(tabs.length).toBeGreaterThan(5)
    expect(tabs.some(t => t.getAttribute('aria-selected') === 'true')).toBe(false)
  })
})
