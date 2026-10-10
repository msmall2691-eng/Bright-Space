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
vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), getCached: vi.fn(),
  // Returns an unsubscribe in the real module — see useEmployees.
  onCacheInvalidated: vi.fn(() => () => {}),
}))

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
  const { pathname, search } = useLocation()
  return (
    <>
      <div data-testid="loc">{pathname}</div>
      <div data-testid="loc-search">{search}</div>
    </>
  )
}

function renderBoard() {
  return render(<MemoryRouter><OpsBoard /><LocationProbe /></MemoryRouter>)
}

// Home makes up to three GETs: the board payload, ONE /api/schedule/week
// (a Sunday-Saturday WEEK, not a month -- `HomeToday` passes view 'week', so
// `rangeForView` returns `weekRange`), and (office roles only) one
// /api/crew/threads for the Crew box. Route by URL.
//
// The mock mirrors the REAL response keys (scheduling/router.py:5177):
// visits / jobs / unscheduled / properties / clients / degraded / coverage.
// It used to carry only four of them, so anything reading `unscheduled` tested
// as permanently empty while the hook quietly coerced it to [] -- a feature
// could ship broken and stay green. Tests that want rows override.
const EMPTY_WEEK = {
  visits: [], jobs: [], unscheduled: [], properties: [], clients: [],
  degraded: false, coverage: {},
}
function mockGet(boardPayload = PAYLOAD, crewThreads = [], week = EMPTY_WEEK) {
  get.mockImplementation((url) => {
    const u = String(url)
    if (u.startsWith('/api/schedule/week')) return Promise.resolve(week)
    if (u.startsWith('/api/crew/threads')) return Promise.resolve(crewThreads)
    return Promise.resolve(boardPayload)
  })
}

/** A week whose days carry jobs, for the rail. Dates are derived from today so
 *  the fixture never goes stale -- the rail's day keys come from the RANGE the
 *  hook fetched, which is always the current week. */
function weekWithJobs() {
  const now = new Date()
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 12)
  const ymd = (n) => {
    const d = new Date(sunday)
    d.setDate(sunday.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const todayIdx = now.getDay()
  // Two on today, one on the day after Sunday, nothing anywhere else.
  const spec = [[todayIdx, 2], [(todayIdx + 2) % 7, 1]]
  const visits = []
  const jobs = {}
  let id = 1
  for (const [dayIdx, n] of spec) {
    for (let k = 0; k < n; k++) {
      const vid = id++
      visits.push({ id: vid, job_id: vid, scheduled_date: ymd(dayIdx), start_time: `0${8 + k}:00:00`, status: 'scheduled', cleaner_ids: [7] })
      jobs[vid] = { id: vid, title: `Job ${vid}`, scheduled_date: ymd(dayIdx), client_id: null, cleaner_ids: [7] }
    }
  }
  return { ...EMPTY_WEEK, visits, jobs, todayIdx, ymd }
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

/* ── Everything that rides the ONE schedule-week fetch ────────────────────── */
describe('OpsBoard — the week fetch, read three ways', () => {
  it('still costs exactly ONE /api/schedule/week with the rail and the strip mounted', async () => {
    // The assertion this whole slice turns on. `useScheduleData` keeps its
    // state in per-instance refs with no module cache and no in-flight map, so
    // a second mount is a second identical request. The rail and the
    // needs-a-date strip therefore live INSIDE HomeToday, reading the hook
    // result it already has -- not calling the hook again.
    const wk = weekWithJobs()
    mockGet(PAYLOAD, CREW_THREADS, { ...wk, unscheduled: [{ id: 77, client_name: 'Nina Cole', property_name: '4 Elm St' }] })
    renderBoard()
    await screen.findByTestId('home-week-rail')
    await screen.findByTestId('needs-date-strip')

    const weekCalls = get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/schedule/week'))
    expect(weekCalls).toHaveLength(1)
  })

  it('derives a 7-day load rail from the week it already fetched', async () => {
    const wk = weekWithJobs()
    mockGet(PAYLOAD, [], wk)
    renderBoard()
    const rail = await screen.findByTestId('home-week-rail')
    const cells = within(rail).getAllByRole('button')
    // Seven, always -- the day keys come from the fetched RANGE, not from the
    // visits, so a day with nothing booked still gets a column.
    expect(cells).toHaveLength(7)

    // Each cell says something out loud. The visible glyphs are "S", "2", "5",
    // which is all a screen reader would otherwise get.
    expect(cells[wk.todayIdx].getAttribute('aria-label')).toMatch(/, today — 2 jobs$/)
    expect(cells[wk.todayIdx].getAttribute('aria-current')).toBe('date')
    const empty = cells.find(c => /nothing booked$/.test(c.getAttribute('aria-label') || ''))
    expect(empty, 'an empty day should say so, not read as a bare dash').toBeTruthy()

    // Today holds 2; the day two later holds 1; the rest are empty and read as
    // a dash rather than a 0, so the eye skips them instead of parsing them.
    expect(cells[wk.todayIdx].textContent).toContain('2')
    expect(cells[(wk.todayIdx + 2) % 7].textContent).toContain('1')
    const dashes = cells.filter(c => c.textContent.includes('\u2013'))
    expect(dashes).toHaveLength(5)

    // Today is marked by ink weight + a hairline rule, never a fill: a filled
    // cell in a seven-cell strip reads as a selected tab (owner veto).
    expect(cells[wk.todayIdx].className).toMatch(/border-b-2 border-ink/)
    for (const c of cells) expect(c.className).not.toMatch(/bg-(amber|rose|blue|emerald|violet|indigo)-/)
  })

  it('a rail cell opens that day on the calendar', async () => {
    const wk = weekWithJobs()
    mockGet(PAYLOAD, [], wk)
    renderBoard()
    const rail = await screen.findByTestId('home-week-rail')
    fireEvent.click(within(rail).getAllByRole('button')[wk.todayIdx])
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/schedule'))
    // ?date is a real anchor Schedule.jsx parses (it stores currentDate there
    // so a reload stays put), and view=day is its drawn default.
    const search = screen.getByTestId('loc-search').textContent
    expect(search).toContain(`date=${wk.ymd(wk.todayIdx)}`)
    expect(search).toContain('view=day')
  })

  it('surfaces jobs with no date from the SAME response, reusing NeedsDateStrip', async () => {
    // Accepting a quote converts it to a job with no date, and a date-bounded
    // week query can never show those -- they were invisible on the dashboard.
    mockGet(PAYLOAD, [], {
      ...EMPTY_WEEK,
      unscheduled: [
        { id: 77, client_name: 'Nina Cole', property_name: '4 Elm St', quote_id: 9 },
        { id: 78, title: 'Deep clean', property_name: '12 Oak Ave' },
      ],
    })
    renderBoard()
    const strip = await screen.findByTestId('needs-date-strip')
    expect(within(strip).getByText('Needs a date')).toBeTruthy()
    expect(within(strip).getByText('Nina Cole')).toBeTruthy()
    expect(within(strip).getByText('Deep clean')).toBeTruthy()
    // No "Schedule" button here: picking the date is the job page's modal, and
    // the row already links there. (The Schedule page passes onSchedule; we
    // deliberately don't.)
    expect(within(strip).queryByRole('button', { name: /^schedule$/i })).toBeNull()
  })

  it('renders no needs-a-date block when every job has a date', async () => {
    mockGet(PAYLOAD, [], EMPTY_WEEK)
    renderBoard()
    await screen.findByText('Reply overdue — Jess Racco')
    expect(screen.queryByTestId('needs-date-strip')).toBeNull()
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

  it('says which channel a client wrote in on', async () => {
    mockGet(PAYLOAD, CREW_THREADS)
    renderBoard()
    const row = await screen.findByTestId('client-row-conv:7')
    // board_service puts the channel in tags[0].label, capitalized. The box
    // had been dropping it since it shipped -- on a surface whose job is "who
    // is waiting on a reply", how to reply is not a detail.
    expect(within(row).getByText(/Sms/)).toBeTruthy()
    // The other row's channel too, so this isn't passing off one lucky fixture.
    const waiting = screen.getByTestId('client-row-wait-conv:8')
    expect(within(waiting).getByText(/Email/)).toBeTruthy()

    // Rendered as a word, with no second coloured mark: tags[0].tone encodes
    // SEVERITY (rose breached / blue waiting), not channel, and the row's
    // leading dot already says severity. Colouring by urgency while labelling
    // by channel would be the same fact twice in two vocabularies.
    const channel = within(row).getByText(/Sms/)
    expect(channel.className).not.toMatch(/text-(rose|amber|blue|emerald|violet)-/)
    expect(channel.querySelector('.rounded-full')).toBeNull()
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

  it('never gives the tail a column it has no child for', async () => {
    const withNotice = {
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(sec => sec.key === 'systems'
        ? { ...sec, items: [{ id: 'sys:1', severity: 'urgent', title: 'iCal feed stalled', body: '', meta: '', tags: [], actions: [] }] }
        : sec),
    }
    // Office: create flows AND notices -> two up.
    mockGet(withNotice)
    renderBoard()
    let row = await screen.findByTestId('home-tail-row')
    expect(row.className).toContain('shell:grid-cols-2')

    // Office, nothing wrong: Quick actions alone -> one track, not a half-empty
    // two-up and not a spacer div shoving it to the right.
    cleanup(); mockGet(PAYLOAD)
    renderBoard()
    row = await screen.findByTestId('home-tail-row')
    expect(row.className).toContain('shell:grid-cols-1')

    // Viewer: no create flows (they are all writes), so the notices stand alone.
    cleanup()
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'viewer' }))
    mockGet(withNotice)
    renderBoard()
    row = await screen.findByTestId('home-tail-row')
    expect(row.className).toContain('shell:grid-cols-1')
    expect(screen.queryByTestId('home-quick-actions')).toBeNull()
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
    // And the middle column collapses out rather than leaving a blank track:
    // two children (Today + comms) means a two-track template.
    const grid = screen.getByTestId('home-grid')
    expect(grid.className).toContain('shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)]')
    // The page still has exactly one h1 -- the identity line. That is the whole
    // reason the focus headline is an h2: it is conditional, so if it carried
    // the h1 a quiet morning would leave the document with no top-level
    // heading at all.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('has exactly one h1 on a busy morning too', async () => {
    renderBoard()
    await screen.findByText('1 job still needs a cleaner')
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0].textContent).toBe('The Maine Cleaning Co.')
    // The hero line is the biggest type on the page and still an h2 -- heading
    // level is structure, not size.
    expect(screen.getByRole('heading', { level: 2, name: '1 job still needs a cleaner' })).toBeTruthy()
  })

  it('gives the grid a template that matches its child count, per role', async () => {
    // The template used to be keyed on showMiddle ALONE, so a non-office role
    // got a three-track grid holding two children -- a blank column. The role
    // test below checked the rail was gone but never the template it left.
    const quiet = {
      ...PAYLOAD,
      stats: PAYLOAD.stats.filter(st => st.key !== 'overdue'),
      sections: PAYLOAD.sections.map(sec => ['requests', 'money', 'needs_cleaner'].includes(sec.key)
        ? { ...sec, items: [] } : sec),
    }
    // The THREE-track template is gated on xl:, not shell: — 900px leaves about
    // 640px of content once the sidebar and gutters are out, and three tracks
    // of ~184px render a job title as "Cle…". Three children therefore carry
    // BOTH: two tracks from shell:, the third from xl:. Asserted as the `xl:`
    // string so this fails if the third track ever drifts back down to shell:.
    const T3 = 'xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)_minmax(0,1.15fr)]'
    const T2 = 'shell:grid-cols-[minmax(0,1.5fr)_minmax(0,1.15fr)]'

    const cases = [
      { role: 'admin', payload: PAYLOAD, cols: T2, wide: T3, why: 'work + comms = 3' },
      { role: 'admin', payload: quiet, cols: T2, wide: null, why: 'comms only = 2' },
      { role: 'viewer', payload: PAYLOAD, cols: T2, wide: null, why: 'work, no comms = 2' },
      { role: 'viewer', payload: quiet, cols: 'shell:grid-cols-1', wide: null, why: 'Today alone = 1' },
    ]
    for (const { role, payload, cols, wide, why } of cases) {
      cleanup()
      localStorage.setItem('brightbase_user', JSON.stringify({ role, full_name: 'Mariah Small' }))
      mockGet(payload)
      renderBoard()
      const grid = await screen.findByTestId('home-grid')
      expect(grid.className, `${role}, ${why}`).toContain(cols)
      // Never a wider template than there are children to fill it — at ANY
      // breakpoint. Two children must not reach three tracks on a wide screen
      // either; that is the blank track this test was written for.
      if (wide) expect(grid.className, `${role}, ${why}`).toContain(wide)
      else expect(grid.className, `${role}: ${why}`).not.toContain(T3)
    }
  })

  it('packs the comms rail under column A, not as a band below both', async () => {
    // Column A (Today + needs-a-cleaner) runs short and the middle column
    // (requests + money) runs long, so when the rail spanned the full width
    // underneath, row 1 was as tall as the middle column and column A ended
    // with ~370px of nothing below it — the biggest piece of dead space left
    // on the board, and the "stack of full-width bands" shape the bento
    // exists to replace. The rail takes no span instead, so it auto-places
    // into the left track's second row; the middle column spans both rows and
    // keeps flowing past it on the right. At xl: there is a third track and
    // every column is its own again.
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
    mockGet(PAYLOAD)
    renderBoard()
    const rail = await screen.findByTestId('home-comms-rail')
    expect(rail.className).not.toContain('sm:col-span-2')

    // The row-span is the other half of it: without it the rail would land
    // beside the middle column rather than under column A.
    const middle = rail.previousElementSibling
    expect(middle.className).toContain('sm:row-span-2')
    expect(middle.className).toContain('xl:row-span-1')
  })

  it('still spans the pair when there is no middle column to flow past', async () => {
    // Two children (Today + comms) and no `row-span` anywhere: the rail is the
    // only sibling, so at the two-track size it spans both rather than leaving
    // the second track of its row empty — the blank cell, from the other side.
    cleanup()
    localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
    mockGet({
      ...PAYLOAD,
      sections: PAYLOAD.sections.map(sec => ['requests', 'money', 'needs_cleaner'].includes(sec.key)
        ? { ...sec, items: [] } : sec),
    })
    renderBoard()
    const rail = await screen.findByTestId('home-comms-rail')
    expect(rail.className).toContain('sm:col-span-2')
    expect(rail.className).toContain('shell:col-span-1')
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
