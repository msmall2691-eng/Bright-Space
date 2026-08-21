/**
 * OpsBoard — the iOS triage dashboard. Verifies the view logic that isn't the
 * backend's job: it mounts from one /api/dashboard/board fetch, clearing a card
 * moves the progress bar (and persists), the severity chips filter, search
 * narrows the sections, and card `actions` run inline — a plain API action
 * clears the card, a `confirm` action needs a second click before it POSTs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

// `getCached` is used by useEmployees, which the embedded Today timeline
// pulls in for cleaner-name lookup — without it the whole page throws.
vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))

import { get, post, getCached } from '../../api'
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
    { key: 'needs_cleaner', title: 'Needs a cleaner', icon: '🧹', items: [
      { id: 'job:1', severity: 'urgent', title: 'No cleaner assigned', body: 'Denmark Rental', meta: 'today',
        tags: [{ label: 'TURNO', tone: 'blue' }],
        actions: [
          { label: 'Auto-assign', kind: 'api', method: 'POST', endpoint: '/api/jobs/1/auto-assign', done: 'Assigned', clears: true },
          { label: 'Dispatch', kind: 'link', href: '/schedule?view=dispatch' },
        ] },
    ] },
    { key: 'requests', title: 'Requests & quotes', icon: '📋', items: [
      { id: 'quote:2', severity: 'watch', title: 'Wells rental', body: 'Jess Racco', meta: 'Sat',
        tags: [{ label: 'QUOTE', tone: 'indigo' }], actions: [{ label: 'View', kind: 'link', href: '/quotes/2' }] },
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
    { key: 'messages', title: 'Messages', icon: '✉️', items: [] },
    { key: 'systems', title: 'Systems', icon: '🧰', items: [] },
    { key: 'safe_to_ignore', title: 'Safe to Ignore', icon: '🗑️', items: [] },
  ],
}

const WITH_SNAPSHOT = {
  ...PAYLOAD,
  snapshot: {
    money_today: {
      collected: 480, collected_label: '$480', invoiced: 1250, invoiced_label: '$1,250',
      hours: 12.5, hours_label: '12.5h', on_clock: 1, visits_done: 3, visits_total: 5,
    },
    crew: {
      working: [{ cleaner_id: 'a', name: 'Dana', jobs: 3, done: 1 }], working_total: 1,
      off: [], off_total: 0, pending_requests: 0, unassigned_today: 2,
    },
    feeds: {
      total: 3, ok: 2, problem_total: 1, stale_hours: 6,
      problems: [{ id: 1, property_id: 11, property_name: '9 Lakeshore Dr',
        source: 'Airbnb', state: 'failing', detail: '403 Forbidden' }],
    },
    recurring: {
      scanned: 9, healthy: 8, other_issues: 0, stalled_total: 1,
      stalled: [{ schedule_id: 7, title: 'Weekly kitchen + baths', client_id: 4,
        client_name: 'Anna Sweet', cadence: 'Weekly on Wed',
        code: 'active_no_upcoming', message: 'Marked active but has no upcoming visits generated.' }],
    },
  },
}

// Shows where the router currently is, so an action that navigates can be
// asserted without mocking react-router.
function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}

function renderBoard() {
  return render(<MemoryRouter><OpsBoard /><LocationProbe /></MemoryRouter>)
}

// Home makes two independent GETs now: the board payload, and one day of
// /api/schedule/week for the embedded Today timeline. Route by URL so the
// timeline gets a real (empty) schedule shape instead of the board payload.
const EMPTY_DAY = { visits: [], jobs: [], properties: [], clients: [] }
function mockGet(boardPayload = PAYLOAD) {
  get.mockImplementation((url) =>
    Promise.resolve(String(url).startsWith('/api/schedule/week') ? EMPTY_DAY : boardPayload))
}

beforeEach(() => {
  localStorage.clear()
  get.mockReset(); post.mockReset(); getCached.mockReset()
  getCached.mockResolvedValue([])   // crew roster, via useEmployees
  mockGet()
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
    // Target this card's own checkbox rather than "the first one on the
    // page" — section order is a product decision that has changed twice,
    // and a positional selector silently starts testing a different card.
    fireEvent.click(within(screen.getByTestId('board-row-job:1')).getByLabelText('Clear'))
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

  // Owner: "so busy... full of spam" — the inbox-triage pile now collapses to
  // one line by default with a one-tap bulk clear right there, instead of
  // dumping every promo/delivery-failure card inline.
  it('collapses Safe to Ignore by default with a confirm-then-clear', async () => {
    const withNoise = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'safe_to_ignore'
        ? { ...s, items: [
            { id: 'triage:1', severity: 'info', title: 'Jotform', body: "Today's your last chance", meta: '1d',
              tags: [{ label: 'PROMOTIONS', tone: 'gray' }],
              actions: [{ label: 'Delete', kind: 'api', method: 'POST', endpoint: '/api/inbox/triage/1/delete', body: {}, done: 'Deleted' }] },
          ] }
        : s),
    }
    mockGet(withNoise)
    post.mockResolvedValue({ deleted: 1, gmail_trashed: 1 })
    renderBoard()
    await screen.findByText('No cleaner assigned')
    expect(screen.getByText('1 item you can ignore')).toBeTruthy()
    expect(screen.queryByText('Jotform')).toBeNull()   // collapsed: row not rendered
    fireEvent.click(screen.getByRole('button', { name: /^clear all$/i }))
    expect(post).not.toHaveBeenCalled()                // first click only asks
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/inbox/triage/delete-all?section=safe_to_ignore', {})
    expect(await screen.findByText(/Cleared 1 item/i)).toBeTruthy()
  })

  it('hides Clear All while search/filters narrow the board', async () => {
    const withNoise = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'safe_to_ignore'
        ? { ...s, items: [
            { id: 'triage:1', severity: 'info', title: 'Jotform', body: "Today's last chance", meta: '1d',
              tags: [{ label: 'PROMOTIONS', tone: 'gray' }], actions: [] },
          ] }
        : s),
    }
    mockGet(withNoise)
    renderBoard()
    await screen.findByText('No cleaner assigned')
    expect(screen.getByRole('button', { name: /^clear all$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(screen.getByPlaceholderText(/search everything/i), { target: { value: 'wells' } })
    // Narrowed to a search match — the section-wide bulk action must not be
    // offered while it would delete cards the search hid (Codex review).
    expect(screen.queryByRole('button', { name: /^clear all$/i })).toBeNull()
  })

  // Owner: "smaller boxes... it's almost a little redundant" — the old
  // separate "Communication" strip and stat-tile band merged into one row at
  // the top, so a stat tile's value is visible without any scrolling and
  // without a second band lower down repeating it.
  it('shows stat tiles in one merged band near the top, not a separate lower band', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    expect(screen.getAllByText('4')).toHaveLength(1)   // "Unassigned jobs" value — appears once, not twice
    expect(screen.getByText('Unassigned jobs')).toBeTruthy()
    expect(screen.getByText('Collected today')).toBeTruthy()
  })

  // Owner: "not have to scroll so much" — a section with more than the row
  // cap folds the rest behind a "+N more" link instead of rendering every
  // card inline.
  it('caps a long primary section to a few rows with a "+N more" link', async () => {
    const longSection = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'needs_cleaner'
        ? { ...s, items: Array.from({ length: 8 }, (_, i) => ({
            id: `job:${i}`, severity: 'urgent', title: `Unassigned job ${i}`, body: '', meta: '',
            tags: [], actions: [],
          })) }
        : s),
    }
    mockGet(longSection)
    renderBoard()
    await screen.findByText('Unassigned job 0')
    expect(screen.getByText('Unassigned job 4')).toBeTruthy()   // 5th row (cap)
    expect(screen.queryByText('Unassigned job 5')).toBeNull()   // 6th row — folded
    expect(screen.getByText(/\+3 more/)).toBeTruthy()
  })

  // Home's "Draft quote" on a new-lead card creates the draft and then has to
  // land her ON it — an api action whose response carries an href navigates
  // there after the toast. Every other api action (no href) must stay put.
  it('navigates to the record an api action returns an href for', async () => {
    const withLead = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'requests'
        ? { ...s, items: [
            { id: 'lead:5', severity: 'info', title: 'New lead — Dana', body: 'Wants a quote', meta: '2h',
              tags: [{ label: 'RESIDENTIAL', tone: 'indigo' }],
              actions: [
                { label: 'Draft quote', kind: 'api', method: 'POST', endpoint: '/api/ai/quote-from-lead/5', done: 'Draft ready', clears: true },
                { label: 'Open', kind: 'link', href: '/requests/5' },
              ] },
          ] }
        : s),
    }
    mockGet(withLead)
    post.mockResolvedValue({ id: 42, status: 'draft', created: true, href: '/quotes/42' })
    renderBoard()
    await screen.findByText('New lead — Dana')
    fireEvent.click(screen.getByRole('button', { name: /draft quote/i }))
    expect(post).toHaveBeenCalledWith('/api/ai/quote-from-lead/5', {})
    expect(await screen.findByText(/Draft ready — New lead — Dana/i)).toBeTruthy()
    // React Router's navigate lands in a transition, so poll rather than
    // reading the probe on the same tick.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/quotes/42'))
  })

  it('leaves the board in place for api actions with no href', async () => {
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByRole('button', { name: /auto-assign/i }))
    expect(await screen.findByText(/Assigned — No cleaner assigned/i)).toBeTruthy()
    expect(screen.getByTestId('loc').textContent).toBe('/')
  })

  it('expands Safe to Ignore on click to review items', async () => {
    const withNoise = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'safe_to_ignore'
        ? { ...s, items: [
            { id: 'triage:1', severity: 'info', title: 'Jotform', body: "Today's last chance", meta: '1d',
              tags: [{ label: 'PROMOTIONS', tone: 'gray' }], actions: [] },
          ] }
        : s),
    }
    mockGet(withNoise)
    renderBoard()
    await screen.findByText('No cleaner assigned')
    fireEvent.click(screen.getByText('1 item you can ignore'))
    expect(await screen.findByText('Jotform')).toBeTruthy()
  })
})

/**
 * The snapshot row. The owner asked for "a full snapshot of all important
 * aspects" with the schedule "across the top" — these pin both halves of that
 * request, and the fact that all four boxes come out of the board fetch that
 * already happened rather than four new ones.
 */
describe('OpsBoard — snapshot boxes', () => {
  it('spans the calendar across the whole grid, not one cell of it', async () => {
    renderBoard()
    const slot = await screen.findByTestId('home-calendar-slot')
    expect(slot.className).toContain('col-span-full')
  })

  it('renders all four boxes from the board payload, with no extra requests', async () => {
    mockGet(WITH_SNAPSHOT)
    renderBoard()

    expect(await screen.findByText('$480')).toBeTruthy()        // money today
    expect(screen.getByText('Dana')).toBeTruthy()               // crew today
    expect(screen.getByText('9 Lakeshore Dr')).toBeTruthy()     // feed health
    expect(screen.getByText('Weekly kitchen + baths')).toBeTruthy()  // recurring

    // The boxes cost nothing: one board fetch, and none of the endpoints
    // these four would otherwise each have to call for themselves.
    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u === '/api/dashboard/board')).toHaveLength(1)
    for (const owned of ['/api/recurring/cleanup/health', '/api/jobs/time-off',
                         '/api/properties', '/api/jobs/sync-overview']) {
      expect(urls.some(u => u.startsWith(owned))).toBe(false)
    }
  })

  it('keeps the board usable when a snapshot box fails to build server-side', async () => {
    mockGet({ ...WITH_SNAPSHOT, snapshot: { ...WITH_SNAPSHOT.snapshot, feeds: null } })
    renderBoard()

    expect(await screen.findByText('No cleaner assigned')).toBeTruthy()
    expect(screen.getByText('$480')).toBeTruthy()
    expect(screen.queryByText('9 Lakeshore Dr')).toBeNull()
  })

  it('shows no snapshot boxes at all on an older payload without them', async () => {
    renderBoard()   // PAYLOAD has no `snapshot` key
    await screen.findByText('No cleaner assigned')
    expect(screen.queryByText('Crew today')).toBeNull()
    expect(screen.queryByText('Turnover feeds')).toBeNull()
  })
})
