/**
 * OpsBoard — the /dashboard home (Oct 2026 rebuild). Verifies the view logic
 * that isn't the backend's job: it mounts from one /api/dashboard/board fetch;
 * a FOCUS BAR surfaces the single most pressing thing derived from the payload;
 * the THREE-COLUMN GRID shows Today + Flow/Money summaries + the comms rail;
 * the comms rail (Crew from a single /api/crew/threads fetch, Clients from the
 * board's messages) is office-only; a client Resolve runs the inline api action
 * and optimistically clears the row; and systems / safe-to-ignore stay
 * collapsed to a quiet line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

// `getCached` drives useUnreadCount (summary) and useEmployees (the roster the
// Today list pulls in for cleaner-name lookup) — without it the page throws.
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
    { key: 'overdue', label: 'Overdue', value: '1', sub: 'invoices past due', tone: 'red', href: '/billing' },
    { key: 'collected', label: 'Collected today', value: '$39', sub: 'payments in', tone: 'money', href: '/billing' },
  ],
  integrations: [
    { key: 'gmail', label: 'Gmail', status: 'connected', detail: '2 accounts', tone: 'green' },
  ],
  filters: { all: 6, urgent: 2, watch: 3, info: 1, good: 0, recurring: 0 },
  sections: [
    // Messages → the Clients box in the comms rail (office answers from here)
    // with inline Resolve/Reply actions.
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
    // requests → the middle column's incoming-work rows, with the actions
    // board_service.py really attaches: `Draft quote` is an api action with NO
    // confirm string (it is metered — OpsBoard adds one client-side), `Book it`
    // carries its own.
    { key: 'requests', title: 'Requests & quotes', icon: '📋', items: [
      { id: 'lead:5', severity: 'watch', title: 'New lead — inquiry', body: 'Wants a quote', meta: '1h', tags: [],
        actions: [
          { label: 'Draft quote', kind: 'api', method: 'POST', endpoint: '/api/ai/quote-from-lead/5', done: 'Draft ready' },
        ] },
      { id: 'quote-stranded:2', severity: 'urgent', title: 'Accepted, not booked — Jess', body: '$300', meta: 'Sat', tags: [],
        actions: [
          { label: 'Book it', kind: 'api', method: 'POST', endpoint: '/api/quotes/2/schedule', body: {},
            confirm: 'Book this job?', done: 'Booked' },
        ] },
    ] },
    { key: 'needs_cleaner', title: 'Needs a cleaner', icon: '🧹', items: [
      { id: 'job:1', severity: 'urgent', title: 'No cleaner assigned', body: 'Denmark Rental', meta: 'today',
        tags: [{ label: 'TURNO', tone: 'blue' }], actions: [{ label: 'Open', kind: 'link', href: '/jobs/1' }] },
    ] },
    { key: 'money', title: 'Money', icon: '💵', items: [
      { id: 'money:outstanding', severity: 'watch', title: '$250 outstanding', body: 'across 1 invoice', meta: '',
        tags: [{ label: 'AR', tone: 'amber' }], actions: [{ label: 'Chase', kind: 'link', href: '/billing?view=invoices&status=overdue' }] },
      { id: 'invoice:9', severity: 'watch', title: 'INV-9 — Acme', body: '$520 · 12d overdue', meta: '',
        tags: [{ label: 'OVERDUE', tone: 'rose' }],
        actions: [
          { label: 'Mark paid', kind: 'api', method: 'POST', endpoint: '/api/invoices/9/pay', body: {},
            confirm: 'Mark this invoice paid?', done: 'Paid' },
        ] },
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

const CREW_THREADS = [
  { user_id: 11, name: 'Dana Jones', status: 'active', unread: 2,
    last_message: { sender: 'cleaner', sender_name: 'Dana', body: 'Van won’t start', created_at: '2026-08-10T13:00:00Z' },
    last_activity: '2026-08-10T13:00:00Z' },
  { user_id: 12, name: 'Pat Lee', status: 'active', unread: 0,
    last_message: { sender: 'office', sender_name: 'You', body: 'Thanks!', created_at: '2026-08-10T10:00:00Z' },
    last_activity: '2026-08-10T10:00:00Z' },
]

function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}

function renderBoard() {
  return render(<MemoryRouter><OpsBoard /><LocationProbe /></MemoryRouter>)
}

// Home now makes up to three GETs: the board payload, one month of
// /api/schedule/week for the Today list, and (office roles only) one
// /api/crew/threads for the Crew box. Route by URL.
const EMPTY_DAY = { visits: [], jobs: [], properties: [], clients: [] }
function mockGet(boardPayload = PAYLOAD, crewThreads = []) {
  get.mockImplementation((url) => {
    const u = String(url)
    if (u.startsWith('/api/schedule/week')) return Promise.resolve(EMPTY_DAY)
    if (u.startsWith('/api/crew/threads')) return Promise.resolve(crewThreads)
    return Promise.resolve(boardPayload)
  })
}

beforeEach(() => {
  localStorage.clear()
  // Most of Home's comms rail + quick actions are admin/manager-only; default
  // the test user to admin so they render. Individual tests can override.
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  // Spend the approval queue's once-a-day drafting run up front (its own tests
  // cover it; here it's just noise in "did this click POST?" assertions).
  claimDailyDraftRun()
  get.mockReset(); post.mockReset(); getCached.mockReset()
  getCached.mockResolvedValue([])   // crew roster + unread summary
  mockGet()
  post.mockResolvedValue({})
})
afterEach(cleanup)

describe('OpsBoard', () => {
  it('mounts from one board fetch: focus bar + messages in the Clients box', async () => {
    renderBoard()
    expect(await screen.findByTestId('home-focus')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/dashboard/board')
    // Focus bar surfaces the needs-a-cleaner coverage gap (1 needs_cleaner item).
    expect(screen.getByText('1 job still needs a cleaner')).toBeTruthy()
    // The Clients box renders the waiting conversations.
    expect(screen.getByText('Reply overdue — Jess Racco')).toBeTruthy()
    expect(screen.getByText('Dana Smith')).toBeTruthy()
  })

  it('shows incoming work and money as actionable ROWS, not counts', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    // The rows themselves, with the names and the money on them.
    expect(screen.getByText('New lead — inquiry')).toBeTruthy()
    expect(screen.getByText('Accepted, not booked — Jess')).toBeTruthy()
    expect(screen.getByText('$250 outstanding')).toBeTruthy()
    expect(screen.getByText('INV-9 — Acme')).toBeTruthy()
    // And the actions, on the dashboard, where the work is.
    expect(screen.getByRole('button', { name: /^draft quote$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^book it$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^mark paid$/i })).toBeTruthy()
    // The integer summaries these replaced are GONE. A mount without its
    // deletion shows the same signal twice — that is exactly how the
    // OwnerDashboard duplication happened.
    expect(screen.queryByText('New leads')).toBeNull()
    expect(screen.queryByText('Ready to book')).toBeNull()
    expect(screen.queryByText('Overdue invoices')).toBeNull()
    expect(screen.queryByText('Outstanding')).toBeNull()
  })

  it('runs Mark paid from the dashboard, behind its confirm', async () => {
    renderBoard()
    await screen.findByText('INV-9 — Acme')
    fireEvent.click(screen.getByRole('button', { name: /^mark paid$/i }))
    expect(post).not.toHaveBeenCalled()                  // first click only asks
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/invoices/9/pay', {})
    expect(await screen.findByText(/Paid — INV-9 — Acme/i)).toBeTruthy()
  })

  it('confirms a METERED action even when the payload ships no confirm', async () => {
    // `Draft quote` hits /api/ai/quote-from-lead — a billed Anthropic call,
    // and board_service.py attaches no confirm string to it. That was fine
    // while it lived behind a page; as a one-tap button on the landing screen
    // a mis-tap costs money, so OpsBoard adds the step itself (METERED).
    renderBoard()
    await screen.findByText('New lead — inquiry')
    fireEvent.click(screen.getByRole('button', { name: /^draft quote$/i }))
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }))
    expect(post).toHaveBeenCalledWith('/api/ai/quote-from-lead/5', {})
  })

  it('will not let you tick away work — only read-it-and-move-on noise', async () => {
    const withNoise = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(sec => sec.key === 'safe_to_ignore'
        ? { ...sec, items: [
            { id: 'triage:1', severity: 'info', title: 'Jotform promo', body: 'Last chance', meta: '1d',
              tags: [], actions: [] },
          ] }
        : sec),
    }
    mockGet(withNoise)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')

    // An unassigned job and an overdue invoice have NO check-off box. The box
    // is a per-device localStorage hide, so ticking one would bury real work
    // on this laptop while it stayed live on the phone.
    for (const id of ['job:1', 'invoice:9', 'money:outstanding', 'lead:5']) {
      const row = screen.getByTestId(`board-row-${id}`)
      expect(within(row).queryByRole('button', { name: /^(clear|restore)$/i })).toBeNull()
    }

    // Safe-to-ignore noise keeps it — "I've seen this" is that row's whole job.
    fireEvent.click(screen.getByText('1 item you can ignore'))
    const noise = await screen.findByTestId('board-row-triage:1')
    const tick = within(noise).getByRole('button', { name: /^clear$/i })
    fireEvent.click(tick)
    expect(JSON.parse(localStorage.getItem('brightbase_board_cleared'))).toContain('triage:1')
  })

  it('shows the jobs with nobody on them, and never offers to assign one', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    // The job row, not the "1 job still needs a cleaner" count card.
    const rows = screen.getAllByTestId('board-row-job:1')
    expect(rows.length).toBe(1)
    expect(within(rows[0]).getByText('Denmark Rental')).toBeTruthy()
    // brightbase-marketplace: the office does not put a person on a job. The
    // only way off this row is Open (the job) or Open to crew (the schedule).
    // Scoped to the ACTIONS — the row's own title is "No cleaner assigned".
    const labels = within(rows[0]).getAllByRole('button').map(b => b.textContent)
    expect(labels.some(t => /assign|dispatch/i.test(t))).toBe(false)
    expect(labels).toContain('Open')
    expect(screen.getByText('Open to crew')).toBeTruthy()
  })

  it('the focus bar greets the user by first name', async () => {
    renderBoard()
    await screen.findByTestId('home-focus')
    expect(screen.getByText(/, Mariah/)).toBeTruthy()
  })

  it('runs an inline Resolve on a client row, toasts, and clears the row', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(post).toHaveBeenCalledWith('/api/comms/conversations/7/status', { status: 'resolved' })
    expect(await screen.findByText(/Resolved — Reply overdue — Jess Racco/i)).toBeTruthy()
    // Optimistically removed from the Clients box.
    await waitFor(() => expect(screen.queryByText('Reply overdue — Jess Racco')).toBeNull())
    expect(JSON.parse(localStorage.getItem('brightbase_board_cleared'))).toContain('conv:7')
  })

  it('needs a confirm before a client action that asks for one', async () => {
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

  it('Reply on a client row deep-links to the conversation', async () => {
    renderBoard()
    await screen.findByText('Dana Smith')
    // Dana Smith's row has only a Reply (link) action — tapping it navigates.
    fireEvent.click(screen.getByText('Dana Smith'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/comms'))
  })

  it('caps the Clients box and folds the rest behind "+N more"', async () => {
    const many = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(s => s.key === 'messages'
        ? { ...s, items: Array.from({ length: 8 }, (_, i) => ({
            id: `conv:${i}`, severity: 'urgent', title: `Message ${i}`, body: '', meta: '',
            tags: [], actions: [{ label: 'Reply', kind: 'link', href: `/comms?conversation=${i}` }],
          })) }
        : s),
    }
    mockGet(many)
    renderBoard()
    await screen.findByText('Message 0')
    expect(screen.getByText('Message 4')).toBeTruthy()   // 5th row (cap)
    expect(screen.queryByText('Message 5')).toBeNull()   // 6th row — folded
    expect(screen.getByText(/\+3 more/)).toBeTruthy()
  })

  it('shows the trimmed stat tiles in one KPI row', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.getAllByRole('button', { name: /^4\s*Unassigned jobs$/ })).toHaveLength(1)
  })

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

  it('navigates to the record an api action returns an href for', async () => {
    post.mockResolvedValue({ status: 'resolved', href: '/quotes/42' })
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(post).toHaveBeenCalledWith('/api/comms/conversations/7/status', { status: 'resolved' })
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/quotes/42'))
  })

  it('leaves the board in place for api actions with no href', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(await screen.findByText(/Resolved — Reply overdue — Jess Racco/i)).toBeTruthy()
    expect(screen.getByTestId('loc').textContent).toBe('/')
  })
})

/* ── The comms rail (new centerpiece) ─────────────────────────────────────── */
describe('OpsBoard — comms rail', () => {
  it('renders the Crew box from one /api/crew/threads fetch', async () => {
    mockGet(PAYLOAD, CREW_THREADS)
    renderBoard()
    // home-crew is only the box's SHELL. The rows come from a separate
    // /api/crew/threads fetch, so nothing about that request -- not its
    // result, not even that it was issued -- is settled when the testId
    // appears. Both assertions below used to run synchronously after it, and
    // both raced: the text one lost 5 times in 8 runs, and `get` was observed
    // with "Number of calls: 1" (the board payload only, crew not yet
    // requested) once in 24. React 18's scheduler won both every time; React
    // 19's does not. So await the rows FIRST -- once they are on screen the
    // fetch provably happened -- and assert the call after.
    await screen.findByTestId('home-crew')
    // One cleaner, unread shown as a quiet dot+word ("2 new"), not a bubble.
    expect(await screen.findByText('Dana Jones')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/api/crew/threads')
    expect(screen.getByText('2 new')).toBeTruthy()
    expect(screen.getByText('Pat Lee')).toBeTruthy()
  })

  it('opens a cleaner thread in a drawer on tap', async () => {
    mockGet(PAYLOAD, CREW_THREADS)
    renderBoard()
    await screen.findByText('Dana Jones')
    fireEvent.click(screen.getByText('Dana Jones'))
    // The drawer mounts the shared CrewThreadPane, which fetches that thread.
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/crew/messages/11'))
  })

  it('hides the whole comms rail for a non-admin/manager role', async () => {
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'viewer' }))
    mockGet(PAYLOAD, CREW_THREADS)
    renderBoard()
    // The grid still renders (Today / Flow / Money)...
    await screen.findByTestId('home-grid')
    // ...but the comms rail, Crew box and client rows are gone, and the
    // crew endpoint is never hit (it would 403 for a viewer).
    expect(screen.queryByTestId('home-comms-rail')).toBeNull()
    expect(screen.queryByTestId('home-crew')).toBeNull()
    expect(screen.queryByText('Reply overdue — Jess Racco')).toBeNull()
    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/crew/threads'))).toBe(false)
  })
})

/* ── Layout + the declutter's load-bearing moves ──────────────────────────── */
describe('OpsBoard — layout', () => {
  it('lays out a three-column grid with Today and the comms rail', async () => {
    renderBoard()
    const grid = await screen.findByTestId('home-grid')
    expect(grid.className).toContain('grid')
    expect(grid.className).toMatch(/shell:grid-cols-/)
    expect(within(grid).getByTestId('home-today')).toBeTruthy()
    expect(within(grid).getByTestId('home-comms-rail')).toBeTruthy()
  })

  it('puts the bench below the fold, in two packing columns', async () => {
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    const bento = screen.getByTestId('home-bento')
    expect(bento.className).toMatch(/shell:grid-cols-2/)
  })

  it('surfaces money as a Billing summary and systems as a quiet collapsed line', async () => {
    mockGet({
      ...WITH_SNAPSHOT,
      sections: WITH_SNAPSHOT.sections.map(s => s.key === 'systems'
        ? { ...s, items: [{ id: 'sys:1', severity: 'urgent', title: 'iCal feed stalled',
                            body: 'Wells rental, 3 days', meta: '3d', tags: [], actions: [] }] }
        : s),
    })
    renderBoard()
    // Money: the real rows plus a Billing hand-off in the header.
    expect(await screen.findByText('$250 outstanding')).toBeTruthy()
    expect(screen.getByText('Billing')).toBeTruthy()
    // Systems: present, but one quiet collapsed line (row behind it).
    expect(screen.getByText('1 system notice')).toBeTruthy()
    expect(screen.queryByText('iCal feed stalled')).toBeNull()
    fireEvent.click(screen.getByText('1 system notice'))
    expect(await screen.findByText('iCal feed stalled')).toBeTruthy()
  })

  it('keeps the charts, the money tile and the AI strips off the landing page', async () => {
    mockGet(WITH_SNAPSHOT)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')

    // MoneyToday stays unmounted deliberately: it reads hours/on-clock fields
    // the payload stopped filling when the native time clock was removed, so
    // it would render a confident 0 rather than nothing.
    expect(screen.queryByText('$480')).toBeNull()                   // money today
    expect(screen.queryByText('Money, last 12 weeks')).toBeNull()   // trend chart
    expect(screen.queryByText('Requests, last 30 days')).toBeNull() // lead funnel

    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/ai/daily-brief'))).toBe(false)
    expect(urls.some(u => u.startsWith('/api/ai/proposals'))).toBe(false)
  })

  it('mounts feed + recurring health only when something is actually broken', async () => {
    // WITH_SNAPSHOT carries problem_total 1 and stalled_total 1, so both fire,
    // and both come out of the payload the page already fetched.
    mockGet(WITH_SNAPSHOT)
    renderBoard()
    expect(await screen.findByText('9 Lakeshore Dr')).toBeTruthy()      // failing feed
    expect(screen.getByText('Weekly kitchen + baths')).toBeTruthy()     // stalled series
    expect(get.mock.calls.filter(c => String(c[0]) === '/api/dashboard/board')).toHaveLength(1)
  })

  it('renders no health box when the feeds and series are fine', async () => {
    // The subject EXISTS — 3 feeds, 9 series — and both boxes still render
    // nothing. Gating on the subject would leave a permanent "3/3 feeding"
    // card on Home: furniture that never tells you anything.
    mockGet({
      ...WITH_SNAPSHOT,
      snapshot: {
        ...WITH_SNAPSHOT.snapshot,
        feeds: { total: 3, ok: 3, problem_total: 0, stale_hours: 6, problems: [] },
        recurring: { scanned: 9, healthy: 9, other_issues: 0, stalled_total: 0, stalled: [] },
      },
    })
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.queryByText('Turnover feeds')).toBeNull()
    expect(screen.queryByText('Recurring series')).toBeNull()
  })

  it('drops the focus headline, and the middle column, on a quiet morning', async () => {
    mockGet({
      ...PAYLOAD,
      stats: PAYLOAD.stats.filter(st => st.key !== 'overdue'),
      sections: PAYLOAD.sections.map(sec => ['requests', 'money', 'needs_cleaner'].includes(sec.key)
        ? { ...sec, items: [] } : sec),
    })
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    // The greeting and the date stay — they're the section, not the verdict.
    expect(screen.getByTestId('home-focus')).toBeTruthy()
    expect(screen.getByText(/, Mariah/)).toBeTruthy()
    // But no hero line, and above all not a reassurance in 26px type. Scoped
    // to the focus section — the slim identity bar above it owns an h1 too.
    expect(within(screen.getByTestId('home-focus')).queryByRole('heading')).toBeNull()
    expect(screen.queryByText(/on top of it/i)).toBeNull()
    // And the middle column collapses out rather than leaving a blank track.
    const grid = screen.getByTestId('home-grid')
    expect(grid.className).toContain('shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)]')
  })

  it('costs exactly one board fetch (plus the schedule + crew reads)', async () => {
    mockGet(WITH_SNAPSHOT)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')

    const urls = get.mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u === '/api/dashboard/board')).toHaveLength(1)
    // The only reads beyond the board are the shared schedule-week fetch and
    // the single crew-threads fetch — no pipeline/health/properties storms.
    for (const owned of ['/api/recurring/cleanup/health', '/api/jobs/time-off',
                         '/api/properties', '/api/jobs/sync-overview']) {
      expect(urls.some(u => u.startsWith(owned))).toBe(false)
    }
  })
})
