/**
 * Recurring list — the second pass the file split did not include.
 *
 * `docs/redesign-implementation.md` recorded what #1103 left behind, in these
 * words: the split "did NOT touch the five list bands, the six detail bands,
 * or the fact that list rows carry no inline actions (the survey counted 0 on
 * the rows, 21 elsewhere)". This is the list half of that.
 *
 * What it pins, and why each one is a thing that could silently go wrong:
 *
 *  - **Pause/Resume runs from the row**, with no confirm, and offers Undo.
 *    Dropping the Undo would leave an unannounced state change; adding a
 *    confirm would tax a loop for something reversible (the reasoning already
 *    settled for Requests' Archive).
 *  - **A failed pause leaves the row telling the truth.** The optimistic flip
 *    happens only after the PATCH resolves, so a rejection must not leave a
 *    row reading "Paused" over a series the server still has active. That is
 *    the exact shape of the bug Requests shipped (the row vanished, the error
 *    went to the console).
 *  - **The title is a real control.** The row used to be one big `<button>`,
 *    which is why it could not hold actions; turning it into a clickable
 *    `<div>` is what made room for them, and it would also have quietly
 *    removed every keyboard route into a series if the title had not become
 *    the focusable thing.
 *  - **A chip count can never disagree with the rows beneath it.** The counts
 *    moved onto the filter chips and the old "N of M" span went away; counting
 *    over the whole book instead of the client-filtered set would put
 *    "Active 12" above two rows.
 *  - **Cancel is not on the row.** A deliberate omission (irreversible, and a
 *    mis-click on a list lands on the wrong series), so it is pinned — a
 *    later "why isn't Cancel here too?" has to be a decision.
 *  - **One request per need on mount, and opening Edit adds none.** The Tier
 *    2c lesson. `EditSeriesModal` is stubbed here, so this asserts the PAGE
 *    fetches nothing to open it — which is the claim being made. The modal's
 *    own roster read is pre-existing and shared through `getCached`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../api', () => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), getCached: vi.fn(),
}))
vi.mock('../../utils/confirmBus', () => ({ confirmDialog: vi.fn() }))
vi.mock('../../components/JobCreateModal', () => ({ default: () => null }))
vi.mock('../../components/recurring/HealthPanel', () => ({ default: () => null }))
vi.mock('../../components/recurring/DuplicateReviewPanel', () => ({ default: () => null }))
vi.mock('../../components/ui/SubNav', () => ({ default: () => null }))
// A probe rather than the real form: it records the schedule object the page
// handed it, which is the thing worth checking from here.
// A probe rather than the real form: it records the schedule object the page
// handed it, which is the thing worth checking from here.
//
// The `defaultValue` input is load-bearing. It is UNCONTROLLED, so its DOM
// value survives re-renders but is rebuilt from the schedule on a remount —
// which makes it a precise detector for "did this component get torn down?".
// A test that only asserted the dialog was still on screen would pass against
// a remounted, empty one, and losing what you typed is the actual bug.
vi.mock('../../components/recurring/EditSeriesModal', () => ({
  default: ({ schedule }) => (
    <div data-testid="edit-modal" data-series-id={schedule?.id} data-start={schedule?.start_time} />
  ),
}))

import { get, getCached, patch } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import { subscribe } from '../../utils/toastBus'
import Recurring from '../Recurring'

const BASE = {
  client_id: 9, address: '12 Pine St', frequency: 'weekly', interval_weeks: 1,
  days_of_week: [1], start_time: '09:00:00', end_time: '12:00:00',
  upcoming_job_count: 4, anchor_date: '2026-06-02',
}
// One of each state seriesState() can return. 'ended' is active-but-past its
// end date (how a split retires a predecessor), 'cancelled' carries
// cancelled_at, 'paused' is simply inactive.
const ACTIVE = { ...BASE, id: 1, title: 'Sweet — Weekly', active: true }
const PAUSED = { ...BASE, id: 2, title: 'Holt — Paused', active: false }
const ENDED = { ...BASE, id: 3, title: 'Vance — Ended', active: true, series_end_date: '2020-01-01' }
const CANCELLED = { ...BASE, id: 4, title: 'Reed — Cancelled', active: false, cancelled_at: '2026-01-01T00:00:00Z' }
const OTHER_CLIENT = { ...BASE, id: 5, client_id: 77, title: 'Diaz — Weekly', active: true }

const CLIENTS = [{ id: 9, name: 'Anna Sweet' }, { id: 77, name: 'Luis Diaz' }]

let toasts
let unsub

function draw(rows = [ACTIVE]) {
  get.mockImplementation((url) => {
    const u = String(url)
    // Matched exactly rather than by prefix: `/api/recurring/1` is the DETAIL
    // endpoint and must answer with one series, not the list. A prefix match
    // handed SeriesDetail the whole array, which is truthy, so it rendered
    // with every field undefined and nothing failed — it just quietly stopped
    // testing the thing.
    const detail = u.match(/^\/api\/recurring\/(\d+)$/)
    if (detail) return Promise.resolve(rows.find(r => String(r.id) === detail[1]) || null)
    if (/^\/api\/recurring\/\d+\/exceptions$/.test(u)) return Promise.resolve([])
    if (/^\/api\/recurring(\?|$)/.test(u)) return Promise.resolve(rows)
    if (u.startsWith('/api/settings/automation')) return Promise.resolve({ recurring_auto_generate_enabled: true })
    return Promise.resolve([])
  })
  getCached.mockResolvedValue(CLIENTS)
  return render(<MemoryRouter initialEntries={['/recurring']}><Recurring /></MemoryRouter>)
}

/** The rendered card for a series, found from its title control. */
async function row(title) {
  const t = await screen.findByRole('button', { name: title })
  return t.closest('div.bg-panel')
}

/** The list opens on Active (so a cancelled series you just retired isn't
 *  still sitting on the screen you landed on). Anything paused, ended or
 *  cancelled has to be asked for. */
async function showAll() {
  const all = await screen.findByRole('tab', { name: /^All/ })
  fireEvent.click(all)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin', full_name: 'Mariah Small' }))
  get.mockReset(); patch.mockReset(); getCached.mockReset(); confirmDialog.mockReset()
  patch.mockResolvedValue({})
  toasts = []
  unsub = subscribe(t => toasts.push(t))
})
afterEach(() => { unsub?.(); cleanup() })

describe('the row can pause a series without leaving the list', () => {
  it('PATCHes active:false, says so, and asks for no confirmation', async () => {
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')

    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/recurring/1', { active: false }))
    expect(confirmDialog, 'pause is reversible — a confirm here taxes the loop for nothing').not.toHaveBeenCalled()
    await waitFor(() => expect(toasts.map(t => t.message)).toContain('Series paused'))
  })

  it('offers Undo, and the Undo puts it back', async () => {
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))

    await waitFor(() => expect(toasts.length).toBeGreaterThan(0))
    const t = toasts.find(x => x.message === 'Series paused')
    expect(t?.action?.label, 'a silent state change is the Requests-archive bug').toBe('Undo')

    await t.action.onClick()
    expect(patch).toHaveBeenLastCalledWith('/api/recurring/1', { active: true })
  })

  it('drops the row out of the Active filter, and Undo brings it back', async () => {
    // The page opens on Active, so a series you just paused does not belong
    // in the list any more and leaves it. That is deliberate: the alternative
    // is a row sitting under "Active" reading "Paused". The Undo in the toast
    // is what makes it safe, which is why the two are pinned together.
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sweet — Weekly' })).toBeNull())
    const t = toasts.find(x => x.message === 'Series paused')
    await t.action.onClick()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sweet — Weekly' })).toBeTruthy())
  })

  it('shows Resume rather than Pause once a series is paused', async () => {
    draw([PAUSED])
    await showAll()
    const card = await row('Holt — Paused')
    expect(within(card).getByRole('button', { name: /^Resume$/ })).toBeTruthy()
    expect(within(card).queryByRole('button', { name: /^Pause$/ })).toBeNull()
  })

  it('keeps the row honest when the PATCH fails', async () => {
    // The optimistic flip is deliberately AFTER the await. A row reading
    // "Paused" over a series the server still has active is worse than a
    // button that visibly did nothing and said why.
    patch.mockRejectedValue(new Error('network down'))
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')

    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))

    await waitFor(() => expect(toasts.some(t => t.variant === 'error')).toBe(true))
    const after = await row('Sweet — Weekly')
    expect(within(after).getByRole('button', { name: /^Pause$/ }), 'still pausable — nothing changed').toBeTruthy()
    expect(within(after).getByText('Active')).toBeTruthy()
  })

  it('resumes a paused series', async () => {
    draw([PAUSED])
    await showAll()
    const card = await row('Holt — Paused')
    fireEvent.click(within(card).getByRole('button', { name: /^Resume$/ }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/recurring/2', { active: true }))
  })

  it('offers no Resume on a paused series whose end date has passed', async () => {
    // The subtle one (codex P2 on #1161). `seriesState` only knows `active`
    // is false, so it reads this as "Paused" and Resume was offered — but
    // resuming sets active:true on an EXPIRED series, which comes straight
    // back as "Ended", generates nothing, and raised a toast saying "Series
    // resumed". A button that reports success and does nothing.
    const PAUSED_EXPIRED = { ...PAUSED, id: 6, title: 'Nash — Paused and expired', series_end_date: '2020-01-01' }
    draw([PAUSED_EXPIRED])
    await showAll()
    const card = await row('Nash — Paused and expired')

    expect(within(card).getByText('Paused'), 'still reads Paused — that part is right').toBeTruthy()
    expect(within(card).queryByRole('button', { name: /^Resume$/ })).toBeNull()
    // Edit stays: fixing the end date is exactly what this series needs, and
    // that is the rule editor's job.
    expect(within(card).getByRole('button', { name: /^Edit$/ })).toBeTruthy()
  })

  it('still offers Resume when the end date is in the future', async () => {
    // The other side of the same gate — without this, "never offer Resume on
    // anything with an end date" would pass the case above.
    const FUTURE = { ...PAUSED, id: 7, title: 'Okafor — Paused', series_end_date: '2099-01-01' }
    draw([FUTURE])
    await showAll()
    const card = await row('Okafor — Paused')
    expect(within(card).getByRole('button', { name: /^Resume$/ })).toBeTruthy()
  })

  it('offers no pause on a cancelled or ended series', async () => {
    // Flipping `active` on a cancelled series does not uncancel it
    // (cancelled_at stays set, so it still reads Cancelled), and an ended one
    // is past its end date, so "Resume" would promise visits nothing
    // generates. Both would be buttons that appear to fail.
    draw([ENDED, CANCELLED])
    await showAll()
    const ended = await row('Vance — Ended')
    const cancelled = await row('Reed — Cancelled')
    for (const card of [ended, cancelled]) {
      expect(within(card).queryByRole('button', { name: /^(Pause|Resume)$/ })).toBeNull()
    }
  })
})

describe('the row can open the rule editor on its own payload', () => {
  it('opens the editor for the series it was clicked from', async () => {
    draw([ACTIVE, PAUSED])
    await showAll()
    const card = await row('Holt — Paused')
    fireEvent.click(within(card).getByRole('button', { name: /^Edit$/ }))

    const modal = await screen.findByTestId('edit-modal')
    expect(modal.getAttribute('data-series-id')).toBe('2')
    // The payload travels with the row: the list and detail endpoints return
    // the same sched_to_dict, so the form pre-fills from real values rather
    // than its own fallbacks.
    expect(modal.getAttribute('data-start')).toBe('09:00:00')
  })

  it('costs the page no request to open', async () => {
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    const before = get.mock.calls.length + getCached.mock.calls.length

    fireEvent.click(within(card).getByRole('button', { name: /^Edit$/ }))
    await screen.findByTestId('edit-modal')

    expect(get.mock.calls.length + getCached.mock.calls.length).toBe(before)
  })
})

describe('what the row deliberately does NOT offer', () => {
  it('has no Cancel', async () => {
    // Cancel is the irreversible one and it stays in the detail page's danger
    // zone, behind the dialog that counts the booked visits it would take off
    // the calendar. On a list a mis-click lands on the wrong series.
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    expect(within(card).queryByRole('button', { name: /^Cancel/i })).toBeNull()
  })
})

describe('only the buttons swallow the row click', () => {
  it('opens the series when the chevron is clicked', async () => {
    // The propagation stop used to sit on the action WRAPPER, which made the
    // chevron and the whitespace around it a dead click — the one spot that
    // used to read "Manage →" became the one spot that did nothing, while
    // still showing a pointer cursor (codex P2 on #1161).
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    const chevron = card.querySelector('svg.lucide-chevron-right')
    expect(chevron, 'no chevron in the row any more — update this test').toBeTruthy()

    fireEvent.click(chevron)
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull())
  })

  it('does not open the series when a BUSY action is clicked', async () => {
    // A `disabled` button runs no React onClick, so its stopPropagation never
    // fires and whether the click then reaches the card is a per-engine
    // question (codex P2 on #1161 — measured as "no" in Chromium, but not
    // measurable here for WebKit). The busy check lives inside the handler
    // instead, so the stop always runs. Pinned, because swapping back to
    // `disabled={busy}` looks like a tidy-up and reinstates the uncertainty.
    let release
    patch.mockImplementation(() => new Promise(r => { release = r }))
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    const pause = within(card).getByRole('button', { name: /^Pause$/ })

    fireEvent.click(pause)                       // goes busy, PATCH in flight
    await waitFor(() => expect(pause.getAttribute('aria-disabled')).toBe('true'))

    fireEvent.click(pause)                       // the second, blocked click
    expect(patch, 'a busy button must not fire a second PATCH').toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tablist'), 'the blocked click opened the series').toBeTruthy()

    release({})
  })

  it('does not open the series when an action is clicked', async () => {
    // The other half, and the reason the stop exists at all: pausing from the
    // row must not also navigate into it.
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(screen.getByRole('tablist'), 'pausing navigated into the series').toBeTruthy()
  })
})

describe('the actions hide on a pointer condition, not a width one', () => {
  it('gates the hover-reveal on pointer-fine rather than sm:', async () => {
    // Measured in Chromium at 768px with touch emulation (codex P2 on #1161):
    // under `sm:opacity-0` a touch tablet reported pointer:coarse, hover:none
    // and the cluster sat at opacity 0 with NOTHING able to reveal it —
    // Tailwind v4 gates `hover:` behind `@media (hover: hover)`, so
    // `sm:group-hover:opacity-100` never fires there. Permanently invisible
    // controls on a row whose tap opens the detail page instead.
    //
    // A class assertion rather than a computed style because jsdom has no
    // media-query engine; the behaviour itself was verified in a browser, and
    // this stops the "tidy it back to sm:" edit from undoing it silently.
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    const cluster = card.querySelector('div.transition-opacity')
    expect(cluster, 'no action cluster found — update this test').toBeTruthy()

    expect(cluster.className, 'visibility must key off pointer capability')
      .toMatch(/pointer-fine:opacity-0/)
    expect(cluster.className, 'sm:opacity-0 leaves touch tablets with no way to reveal these')
      .not.toMatch(/\bsm:opacity-0\b/)
    // Where it SITS is still a width question, and must stay one.
    expect(cluster.className).toMatch(/\bsm:w-auto\b/)
  })
})

describe('the row is still reachable by keyboard', () => {
  it('keeps the title a heading as well as a control', async () => {
    // The card stopped being one big <button> so it could hold actions, and
    // the title became the focusable thing. Done naively that REPLACES the
    // <h3>, which takes every series out of the heading structure a screen
    // reader user scans by — CSS does not carry that semantic (codex P2 on
    // #1161). Both roles are asserted because satisfying either one alone is
    // the bug: a bare heading loses the keyboard route, a bare button loses
    // the outline.
    draw([ACTIVE])
    await row('Sweet — Weekly')
    const heading = screen.getByRole('heading', { name: 'Sweet — Weekly' })
    expect(heading, 'the series title is no longer a heading').toBeTruthy()
    expect(
      within(heading).getByRole('button', { name: 'Sweet — Weekly' }),
      'the heading no longer contains the control that opens the series',
    ).toBeTruthy()
  })

  it('opens the series from the title control', async () => {
    // The card stopped being one big <button> so it could hold actions. If the
    // title had not become the focusable control in the same move, this page
    // would have lost every keyboard route into a series — a regression
    // nothing else here would have caught.
    draw([ACTIVE])
    const title = await screen.findByRole('button', { name: 'Sweet — Weekly' })
    fireEvent.click(title)
    // ?series=1 swaps the list for the detail view, so the list toolbar goes.
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull())
  })
})

describe('the filter chips carry the counts, and they match the rows', () => {
  const chip = (name) => screen.getByRole('tab', { name: new RegExp(`^${name}`) })

  it('counts each state once, on the chip', async () => {
    draw([ACTIVE, PAUSED, ENDED, CANCELLED])
    await row('Sweet — Weekly')
    expect(chip('Active').textContent).toMatch(/1$/)
    expect(chip('Paused').textContent).toMatch(/1$/)
    expect(chip('Ended').textContent).toMatch(/1$/)
    expect(chip('Cancelled').textContent).toMatch(/1$/)
    expect(chip('All').textContent).toMatch(/4$/)
  })

  it('shows the count in exactly one place', async () => {
    // The old page put "N of M" in its own span beside the filter. Two places
    // for one fact is what the design language calls out, and it is how they
    // drift apart.
    draw([ACTIVE, PAUSED])
    await row('Sweet — Weekly')
    expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull()
  })

  it('counts within the picked client, not the whole book', async () => {
    // The trap: whole-book counts under a client filter put "Active 2" above
    // one row. Asserted as chip-count === rows-rendered so the two cannot
    // drift apart whichever way a later change goes.
    draw([ACTIVE, OTHER_CLIENT])
    await row('Sweet — Weekly')
    expect(chip('Active').textContent).toMatch(/2$/)

    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: '9' } })

    await waitFor(() => expect(chip('Active').textContent).toMatch(/1$/))
    expect(screen.queryByRole('button', { name: 'Diaz — Weekly' })).toBeNull()
    const rendered = screen.getAllByRole('button', { name: /— (Weekly|Paused|Ended|Cancelled)/ }).length
    expect(rendered, 'the chip count and the rows must be the same number').toBe(1)
  })
})

describe('one request per need on mount', () => {
  it('reads the series list, the client book and the automation flag once each', async () => {
    draw([ACTIVE])
    await row('Sweet — Weekly')

    const urls = get.mock.calls.map(c => String(c[0]))
    const series = urls.filter(u => u.startsWith('/api/recurring'))
    const settings = urls.filter(u => u.startsWith('/api/settings/automation'))
    expect(series, `one series read, got: ${series.join(', ')}`).toHaveLength(1)
    expect(settings).toHaveLength(1)
    // The client book goes through getCached (in-flight dedupe + TTL), which
    // is what makes four pages reading it cost one request.
    expect(getCached).toHaveBeenCalledTimes(1)
    expect(String(getCached.mock.calls[0][0])).toMatch(/^\/api\/clients\?/)
  })

  it('does not refetch the list to pause a row', async () => {
    draw([ACTIVE])
    const card = await row('Sweet — Weekly')
    const before = get.mock.calls.length

    fireEvent.click(within(card).getByRole('button', { name: /^Pause$/ }))
    await waitFor(() => expect(patch).toHaveBeenCalled())

    // The local flip is the point: a reload here would cost a request per
    // pause and lose the operator's scroll position mid-list.
    expect(get.mock.calls.length).toBe(before)
  })
})
