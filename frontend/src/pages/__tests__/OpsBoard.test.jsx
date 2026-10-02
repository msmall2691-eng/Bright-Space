/**
 * OpsBoard — the /dashboard home. Verifies the view logic that isn't the
 * backend's job: it mounts from one /api/dashboard/board fetch; the Messages
 * list (the one full list left on Home) is searchable/filterable and its cards
 * clear and run inline actions; the pipeline sections (requests / needs_cleaner
 * / money) render as SUMMARY cards that link to Flow / Billing instead of
 * re-listing every row; and systems / safe-to-ignore stay collapsed to a quiet
 * line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

// `getCached` is used by useEmployees, which the embedded Today timeline
// pulls in for cleaner-name lookup — without it the whole page throws.
vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))

import { get, post, getCached } from '../../api'
import { claimDailyDraftRun } from '../../components/board/ProposalsQueue'
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
  filters: { all: 6, urgent: 2, watch: 3, info: 1, good: 0, recurring: 0 },
  sections: [
    // Messages stays a LIST on Home (the office answers from here) with inline
    // Resolve/Reply actions — the only full list left after the declutter.
    { key: 'messages', title: 'Messages', icon: '✉️', items: [
      { id: 'conv:7', severity: 'urgent', title: 'Reply overdue — Jess Racco', body: 'Can you come Saturday?', meta: '2h',
        tags: [{ label: 'Sms', tone: 'rose' }],
        actions: [
          { label: 'Resolve', kind: 'api', method: 'POST', endpoint: '/api/comms/conversations/7/status', body: { status: 'resolved' }, done: 'Resolved', clears: true },
          { label: 'Reply', kind: 'link', href: '/comms?conversation=7' },
        ] },
      { id: 'wait-conv:8', severity: 'watch', title: 'Dana Smith', body: 'Thanks so much!', meta: '5h',
        tags: [{ label: 'Email', tone: 'blue' }],
        actions: [{ label: 'Reply', kind: 'link', href: '/comms?conversation=8' }] },
    ] },
    // Pipeline sections → SUMMARY cards. They no longer carry inline actions on
    // Home: the row-level work (Draft quote, Book it, Mark paid) lives on the
    // Flow / Billing pages those cards link to.
    { key: 'requests', title: 'Requests & quotes', icon: '📋', items: [
      { id: 'quote:2', severity: 'watch', title: 'Wells rental', body: 'Jess Racco', meta: 'Sat',
        tags: [{ label: 'QUOTE', tone: 'indigo' }], actions: [] },
    ] },
    { key: 'needs_cleaner', title: 'Needs a cleaner', icon: '🧹', items: [
      { id: 'job:1', severity: 'urgent', title: 'No cleaner assigned', body: 'Denmark Rental', meta: 'today',
        tags: [{ label: 'TURNO', tone: 'blue' }], actions: [] },
    ] },
    { key: 'money', title: 'Money', icon: '💵', items: [
      { id: 'money:outstanding', severity: 'watch', title: '$250 outstanding', body: 'across 1 invoice', meta: '',
        tags: [{ label: 'AR', tone: 'amber' }], actions: [] },
      { id: 'invoice:9', severity: 'watch', title: 'INV-9 — Acme', body: '$520 · 12d overdue', meta: '',
        tags: [{ label: 'OVERDUE', tone: 'rose' }], actions: [] },
    ] },
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
    money_trend: {
      weeks: 12, collected_total: 4200, invoiced_total: 3900, has_data: true,
      points: Array.from({ length: 12 }, (_, n) => ({
        week: `2026-03-${String(2 + n).padStart(2, '0')}`, label: `Mar ${2 + n}`,
        collected: 100 * (n + 1), invoiced: 90 * (n + 1),
      })),
    },
    lead_funnel: {
      window_days: 30, overall_pct: 25.0, has_data: true,
      steps: [
        { key: 'requests', label: 'Requests', count: 8 },
        { key: 'quoted', label: 'Quoted', count: 5 },
        { key: 'accepted', label: 'Accepted', count: 3 },
        { key: 'won', label: 'Won', count: 2 },
      ],
      widths: [100, 63, 38, 25],
      by_source: [{ source: 'website', requests: 8, won: 2 }],
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

// Home makes two independent GETs now: the board payload, and one month of
// /api/schedule/week for the embedded calendar. Route by URL so the calendar
// gets a real (empty) schedule shape instead of the board payload.
const EMPTY_DAY = { visits: [], jobs: [], properties: [], clients: [] }
function mockGet(boardPayload = PAYLOAD) {
  get.mockImplementation((url) =>
    Promise.resolve(String(url).startsWith('/api/schedule/week') ? EMPTY_DAY : boardPayload))
}

beforeEach(() => {
  localStorage.clear()
  // Spend the approval queue's once-a-day drafting run up front. It fires a
  // POST on mount, which is ProposalsQueue's behaviour and has its own tests —
  // here it would just be noise in every "did this click POST?" assertion.
  claimDailyDraftRun()
  get.mockReset(); post.mockReset(); getCached.mockReset()
  getCached.mockResolvedValue([])   // crew roster, via useEmployees
  mockGet()
  post.mockResolvedValue({})
})
afterEach(cleanup)

describe('OpsBoard', () => {
  it('mounts from one board fetch: messages list + pipeline summaries', async () => {
    renderBoard()
    expect(await screen.findByText('The Maine Cleaning Co.')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/dashboard/board')
    // Messages renders as a list...
    expect(screen.getByText('Reply overdue — Jess Racco')).toBeTruthy()
    // ...and the pipeline sections render as summary cards that preview the top
    // line (the full lists live on Flow / Billing).
    expect(screen.getByText('No cleaner assigned')).toBeTruthy() // needs_cleaner summary
    expect(screen.getByText('Wells rental')).toBeTruthy()        // requests summary
    // Cleared-progress is scoped to the Messages list (2 items).
    expect(screen.getByText('0 of 2 cleared')).toBeTruthy()
  })

  it('pipeline summaries link out to Flow and Billing, not full row lists', async () => {
    renderBoard()
    await screen.findByText('Wells rental')
    // The requests/needs_cleaner cards hand off to Flow; money hands off to
    // Billing. Clicking the money card navigates to /billing.
    expect(screen.getByText('Billing')).toBeTruthy()
    expect(screen.getAllByText('Open Flow').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByText('$250 outstanding'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/billing'))
  })

  it('clearing a message advances the progress and persists', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(within(screen.getByTestId('board-row-conv:7')).getByLabelText('Clear'))
    expect(screen.getByText('1 of 2 cleared')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('brightbase_board_cleared'))).toContain('conv:7')
  })

  // Search + severity chips fold behind the quiet "Filters" disclosure (owner:
  // "this is so busy") and are scoped to the Messages list now.
  it('severity chips filter the visible messages', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.click(screen.getByRole('button', { name: /urgent/i }))
    expect(screen.getByText('Reply overdue — Jess Racco')).toBeTruthy() // urgent
    expect(screen.queryByText('Dana Smith')).toBeNull()                 // watch → hidden
  })

  it('search narrows the messages list', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(screen.getByPlaceholderText(/search messages/i), { target: { value: 'jess' } })
    expect(screen.getByText('Reply overdue — Jess Racco')).toBeTruthy()
    expect(screen.queryByText('Dana Smith')).toBeNull()
  })

  it('runs an inline API action on a message and clears the card', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(post).toHaveBeenCalledWith('/api/comms/conversations/7/status', { status: 'resolved' })
    expect(await screen.findByText(/Resolved — Reply overdue — Jess Racco/i)).toBeTruthy()
    expect(screen.getByText('1 of 2 cleared')).toBeTruthy()
  })

  // The per-row confirm UI is generic runAction machinery — any card whose api
  // action carries a `confirm` string gets a two-step press before it POSTs.
  it('needs a confirm before a card action that asks for one', async () => {
    const withConfirm = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'messages'
        ? { ...s, items: [
            { id: 'conv:9', severity: 'urgent', title: 'Close out — Acme', body: 'Resolved by phone', meta: '1h',
              tags: [{ label: 'Sms', tone: 'rose' }],
              actions: [
                { label: 'Resolve', kind: 'api', method: 'POST', endpoint: '/api/comms/conversations/9/status',
                  body: { status: 'resolved' }, confirm: 'Resolve this conversation?', done: 'Resolved', clears: true },
              ] },
          ] }
        : s),
    }
    mockGet(withConfirm)
    renderBoard()
    await screen.findByText('Close out — Acme')
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }))
    expect(post).not.toHaveBeenCalled()                 // first click only asks
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/comms/conversations/9/status', { status: 'resolved' })
  })

  // Owner: "so busy... full of spam" — the inbox-triage pile collapses to one
  // line by default with a one-tap bulk clear right there.
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
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.getByText('1 item you can ignore')).toBeTruthy()
    expect(screen.queryByText('Jotform')).toBeNull()   // collapsed: row not rendered
    fireEvent.click(screen.getByRole('button', { name: /^clear all$/i }))
    expect(post).not.toHaveBeenCalled()                // first click only asks
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/inbox/triage/delete-all?section=safe_to_ignore', {})
    expect(await screen.findByText(/Cleared 1 item/i)).toBeTruthy()
  })

  it('hides Clear All while a search narrows the board', async () => {
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
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.getByRole('button', { name: /^clear all$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /filters/i }))
    fireEvent.change(screen.getByPlaceholderText(/search messages/i), { target: { value: 'wells' } })
    // Narrowed — the section-wide bulk action must not be offered while it would
    // delete cards the search hid (Codex review).
    expect(screen.queryByRole('button', { name: /^clear all$/i })).toBeNull()
  })

  // Owner: "smaller boxes... it's almost a little redundant" — the KPI band is
  // trimmed to the handful that matter and sits once at the top.
  //
  // ASSERTED ON THE TILE, NOT THE BARE STRING: the tile is a button whose
  // accessible name is its value followed by its label, so matching that cannot
  // collide with a calendar cell, a badge, or the next number on the page.
  it('shows the trimmed stat tiles in one merged band near the top', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.getAllByRole('button', { name: /^4\s*Unassigned jobs$/ })).toHaveLength(1)
    expect(screen.getByText('Unassigned jobs')).toBeTruthy()
    expect(screen.getByText('Collected today')).toBeTruthy()
  })

  // Owner: "not have to scroll so much" — the Messages list caps tight and folds
  // the rest behind a "+N more" into the inbox.
  it('caps the Messages list to a few rows with a "+N more" link', async () => {
    const many = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'messages'
        ? { ...s, items: Array.from({ length: 8 }, (_, i) => ({
            id: `conv:${i}`, severity: 'urgent', title: `Message ${i}`, body: '', meta: '',
            tags: [], actions: [],
          })) }
        : s),
    }
    mockGet(many)
    renderBoard()
    await screen.findByText('Message 0')
    expect(screen.getByText('Message 3')).toBeTruthy()   // 4th row (cap)
    expect(screen.queryByText('Message 4')).toBeNull()   // 5th row — folded
    expect(screen.getByText(/\+4 more/)).toBeTruthy()
  })

  // An api action whose response carries an href navigates there after the
  // toast; every other api action stays put.
  it('navigates to the record an api action returns an href for', async () => {
    post.mockResolvedValue({ status: 'resolved', href: '/quotes/42' })
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(post).toHaveBeenCalledWith('/api/comms/conversations/7/status', { status: 'resolved' })
    expect(await screen.findByText(/Resolved — Reply overdue — Jess Racco/i)).toBeTruthy()
    // React Router's navigate lands in a transition, so poll rather than
    // reading the probe on the same tick.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/quotes/42'))
  })

  it('leaves the board in place for api actions with no href', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(await screen.findByText(/Resolved — Reply overdue — Jess Racco/i)).toBeTruthy()
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
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByText('1 item you can ignore'))
    expect(await screen.findByText('Jotform')).toBeTruthy()
  })
})

/**
 * The above-the-fold split and the declutter's load-bearing moves.
 */
describe('OpsBoard — layout', () => {
  it('puts the schedule beside the Messages column, above the fold', async () => {
    renderBoard()
    const slot = await screen.findByTestId('home-calendar-slot')
    const row = screen.getByTestId('home-abovefold')
    // The calendar is one track of the above-the-fold grid...
    expect(row.contains(slot)).toBe(true)
    expect(row.className).toContain('grid')
    expect(row.className).toMatch(/shell:grid-cols-/)
    // ...and the other track is the Messages column — a packing flex column.
    expect(row.querySelector(':scope > .flex.flex-col')).toBeTruthy()
  })

  it('puts the bench below the fold, in two packing columns', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    const bento = screen.getByTestId('home-bento')
    expect(bento.className).toMatch(/shell:grid-cols-2/)
  })

  it('surfaces money as a Billing summary and systems as a quiet collapsed line', async () => {
    // The load-bearing assertion of the declutter. Money and systems no longer
    // re-list every row on Home — money previews its top line and hands off to
    // Billing (which owns the full list now), and systems folds to one quiet
    // collapsed line with the rows a tap behind it. The records aren't lost,
    // they're delegated to the page that owns them.
    mockGet({
      ...WITH_SNAPSHOT,
      sections: WITH_SNAPSHOT.sections.map(s => s.key === 'systems'
        ? { ...s, items: [{ id: 'sys:1', severity: 'urgent', title: 'iCal feed stalled',
                            body: 'Wells rental, 3 days', meta: '3d', tags: [], actions: [] }] }
        : s),
    })
    renderBoard()

    // Money: a summary card previewing the top line + a Billing hand-off.
    expect(await screen.findByText('$250 outstanding')).toBeTruthy()
    expect(screen.getByText('Billing')).toBeTruthy()
    // Systems: present, but one quiet collapsed line (row behind it).
    expect(screen.getByText('1 system notice')).toBeTruthy()
    expect(screen.queryByText('iCal feed stalled')).toBeNull()
    fireEvent.click(screen.getByText('1 system notice'))
    expect(await screen.findByText('iCal feed stalled')).toBeTruthy()
  })

  it('no longer renders the snapshot boxes or AI strips on the landing page', async () => {
    mockGet(WITH_SNAPSHOT)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')

    // Cut by the owner: the four snapshot boxes and the two charts...
    expect(screen.queryByText('$480')).toBeNull()                   // money today
    expect(screen.queryByText('Dana')).toBeNull()                   // crew today
    expect(screen.queryByText('9 Lakeshore Dr')).toBeNull()         // feed health
    expect(screen.queryByText('Weekly kitchen + baths')).toBeNull() // recurring
    expect(screen.queryByText('Money, last 12 weeks')).toBeNull()   // trend chart
    expect(screen.queryByText('Requests, last 30 days')).toBeNull() // lead funnel

    // ...and both AI strips, which moved to the Assistant tab. Their endpoints
    // are the point: each was a completion racing the real data on first paint.
    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/ai/daily-brief'))).toBe(false)
    expect(urls.some(u => u.startsWith('/api/ai/proposals'))).toBe(false)
  })

  it('still costs exactly one board fetch', async () => {
    mockGet(WITH_SNAPSHOT)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')

    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u === '/api/dashboard/board')).toHaveLength(1)
    for (const owned of ['/api/recurring/cleanup/health', '/api/jobs/time-off',
                         '/api/properties', '/api/jobs/sync-overview']) {
      expect(urls.some(u => u.startsWith(owned))).toBe(false)
    }
  })
})
