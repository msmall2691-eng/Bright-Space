/**
 * Home's four snapshot boxes.
 *
 * These are pure views over `board.snapshot`, so what's worth pinning is the
 * judgement in them, not the plumbing: a box with no subject disappears
 * instead of sitting on Home saying nothing, an open punch is reported rather
 * than added to today's hours, and every problem row lands on the screen where
 * the fix actually is.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { MoneyToday, CrewToday, FeedHealth, RecurringHealth } from '../SnapshotBoxes'

const draw = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)

afterEach(cleanup)

const MONEY = {
  collected: 480, collected_label: '$480',
  invoiced: 1250, invoiced_label: '$1,250',
  hours: 12.5, hours_label: '12.5h', on_clock: 2,
  visits_done: 3, visits_total: 5,
}

describe('MoneyToday', () => {
  it('shows money in, money billed, hours and visits as four plain numbers', () => {
    draw(<MoneyToday snap={MONEY} />)
    expect(screen.getByText('$480')).toBeTruthy()
    expect(screen.getByText('$1,250')).toBeTruthy()
    expect(screen.getByText('12.5h')).toBeTruthy()
    expect(screen.getByText('3/5')).toBeTruthy()
  })

  it('reports who is still on the clock instead of folding them into hours', () => {
    draw(<MoneyToday snap={MONEY} />)
    expect(screen.getByText('2 still on the clock')).toBeTruthy()
  })

  it('says nothing is booked rather than showing 0/0', () => {
    draw(<MoneyToday snap={{ ...MONEY, visits_done: 0, visits_total: 0, on_clock: 0 }} />)
    expect(screen.getByText('nothing booked')).toBeTruthy()
    expect(screen.queryByText('0/0')).toBeNull()
    expect(screen.queryByText(/on the clock/)).toBeNull()
  })

  it('collapses to one line before the day has started', () => {
    // $0 in, $0 billed, 0h and no visits is four zeroes in a 2x2 grid saying
    // "nothing yet" four times.
    draw(<MoneyToday snap={{
      collected: 0, collected_label: '$0', invoiced: 0, invoiced_label: '$0',
      hours: 0, hours_label: '0h', on_clock: 0, visits_done: 0, visits_total: 0,
    }} />)
    expect(screen.getByText(/nothing booked and nothing collected/i)).toBeTruthy()
    expect(screen.queryByText('Crew hours')).toBeNull()
  })

  it('renders nothing when the box failed to build server-side', () => {
    const { container } = draw(<MoneyToday snap={null} />)
    expect(container.textContent).toBe('')
  })
})

const CREW = {
  working: [
    { cleaner_id: 'a', name: 'Dana', jobs: 3, done: 1 },
    { cleaner_id: 'b', name: 'Sam', jobs: 1, done: 0 },
  ],
  working_total: 2,
  off: [{ cleaner_id: 'c', name: 'Amy', reason: 'vacation', back: '2026-08-25' }],
  off_total: 1,
  pending_requests: 1,
  unassigned_today: 2,
}

describe('CrewToday', () => {
  it('shows each cleaner’s load and their progress through it', () => {
    draw(<CrewToday snap={CREW} />)
    expect(screen.getByText('1/3 done')).toBeTruthy()   // Dana, partway
    expect(screen.getByText('1 job')).toBeTruthy()      // Sam, nothing done yet
  })

  it('lists who is off and why, without hiding them from the day', () => {
    draw(<CrewToday snap={CREW} />)
    expect(screen.getByText('Amy')).toBeTruthy()
    expect(screen.getByText('vacation')).toBeTruthy()
  })

  it('links unassigned work to dispatch and time-off requests to the decision screen', () => {
    draw(<CrewToday snap={CREW} />)
    expect(screen.getByText('2 visits with nobody on it').closest('a').getAttribute('href'))
      .toBe('/schedule?view=dispatch')
    expect(screen.getByText('1 time-off request to decide').closest('a').getAttribute('href'))
      .toBe('/schedule?tab=availability')
  })

  it('disappears on a day with no crew, no absences and nothing unassigned', () => {
    const { container } = draw(<CrewToday snap={{
      working: [], working_total: 0, off: [], off_total: 0,
      pending_requests: 0, unassigned_today: 0,
    }} />)
    expect(container.textContent).toBe('')
  })
})

const FEEDS = {
  total: 4, ok: 1, problem_total: 3, stale_hours: 6,
  problems: [
    { id: 1, property_id: 11, property_name: '9 Lakeshore Dr', source: 'Airbnb',
      state: 'failing', detail: '403 Forbidden from Airbnb' },
    { id: 2, property_id: 12, property_name: 'Denmark Rental', source: 'Vrbo',
      state: 'stale', detail: 'Last synced 2d ago' },
    { id: 3, property_id: 13, property_name: 'Bridgton Cabin', source: 'Ical',
      state: 'never', detail: 'Never synced' },
  ],
}

describe('FeedHealth', () => {
  it('is absent entirely for a business with no rental calendars', () => {
    const { container } = draw(<FeedHealth snap={{ total: 0, ok: 0, problems: [], problem_total: 0 }} />)
    expect(container.textContent).toBe('')
  })

  it('names the house whose bookings stopped arriving, and why', () => {
    draw(<FeedHealth snap={FEEDS} />)
    expect(screen.getByText('9 Lakeshore Dr')).toBeTruthy()
    expect(screen.getByText('403 Forbidden from Airbnb')).toBeTruthy()
    expect(screen.getByText('Never synced')).toBeTruthy()
    expect(screen.getByText('1/4 feeding')).toBeTruthy()
  })

  it('sends each problem to that property’s own feed list, where the fix is', () => {
    draw(<FeedHealth snap={FEEDS} />)
    expect(screen.getByText('9 Lakeshore Dr').getAttribute('href')).toBe('/properties/11/icals')
    expect(screen.getByText('Denmark Rental').getAttribute('href')).toBe('/properties/12/icals')
  })

  it('shrinks to its header when every feed is healthy', () => {
    // A problem list with no problems has nothing to say. It used to spend a
    // full card on a reassuring sentence that repeated the header's own
    // count — a card of dead space on a good day.
    draw(<FeedHealth snap={{ total: 3, ok: 3, problems: [], problem_total: 0 }} />)
    expect(screen.getByText('3/3 feeding')).toBeTruthy()
    expect(screen.queryByText(/calendar synced/i)).toBeNull()
  })
})

const RECURRING = {
  scanned: 12, healthy: 11, other_issues: 0, stalled_total: 1,
  stalled: [{
    schedule_id: 7, title: 'Weekly kitchen + baths', client_id: 4,
    client_name: 'Anna Sweet', cadence: 'Weekly on Wed', code: 'active_no_upcoming',
    message: 'Marked active but has no upcoming visits generated.',
  }],
}

describe('RecurringHealth', () => {
  it('surfaces the series that stopped generating, with its client', () => {
    draw(<RecurringHealth snap={RECURRING} />)
    expect(screen.getByText('Weekly kitchen + baths').getAttribute('href')).toBe('/recurring')
    expect(screen.getByText('Anna Sweet').getAttribute('href')).toBe('/clients/4')
    expect(screen.getByText(/no upcoming visits generated/i)).toBeTruthy()
  })

  it('shrinks to its header when nothing has stalled', () => {
    draw(<RecurringHealth snap={{ scanned: 9, healthy: 9, stalled: [], stalled_total: 0 }} />)
    expect(screen.getByText('9 total')).toBeTruthy()
    expect(screen.queryByText(/has visits/i)).toBeNull()
  })

  it('is absent for a business with no recurring work at all', () => {
    const { container } = draw(<RecurringHealth snap={{ scanned: 0, healthy: 0, stalled: [], stalled_total: 0 }} />)
    expect(container.textContent).toBe('')
  })

  it('offers the full list when more are stalled than fit', () => {
    draw(<RecurringHealth snap={{ ...RECURRING, stalled_total: 6 }} />)
    const more = screen.getByText(/\+5 more/)
    expect(more.closest('a').getAttribute('href')).toBe('/recurring')
  })
})

describe('shared chrome', () => {
  it('uses dots and plain words — no filled pill labels (owner veto)', () => {
    const { container } = draw(
      <>
        <MoneyToday snap={MONEY} />
        <CrewToday snap={CREW} />
        <FeedHealth snap={FEEDS} />
        <RecurringHealth snap={RECURRING} />
      </>,
    )
    const pills = [...container.querySelectorAll('.rounded-full')]
    // Every rounded-full element is a 6px status dot, never a tinted label.
    for (const el of pills) {
      expect(el.textContent).toBe('')
      expect(el.className).toMatch(/\bh-1\.5\b/)
    }
    // And no resting-state tinted panel backgrounds (bg-amber-100 and
    // friends). Matched on whole class names so bg-emerald-500 — a dot — is
    // not mistaken for bg-emerald-50.
    const tinted = [...container.querySelectorAll('*')].filter(el =>
      /\b(bg-(amber|rose|emerald|blue|indigo|violet)-(50|100|200))\b/.test(String(el.className)))
    expect(tinted).toEqual([])
  })
})
