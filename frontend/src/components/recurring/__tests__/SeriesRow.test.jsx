/**
 * The Recurring list row — specifically, that its status dot HAS a colour.
 *
 * `surfaceGuards.test.js` already reads this file's source and fails on a
 * 500-ramp hue or a boxed dot-pill. Both are checks for a WRONG class, and
 * the bug that shipped here was the absence of one:
 *
 *     `h-1.5 w-1.5 rounded-full ${live ? '${SEV_DOT.good}' : 'bg-ink-3'}`
 *
 * — the true branch single-quoted inside the template, so the className ended
 * with the literal nine characters `${SEV_DOT.good}`. Tailwind emits nothing
 * for a class by that name, so the "Active" dot on every live series rendered
 * with no background at all. Three source greps read that exact line and all
 * three passed, because none of them asked whether a dot had a colour.
 *
 * `__tests__/statusDotMigration.test.js` now catches the syntax app-wide. This
 * is the other half, and the half that cannot be fooled by a different spelling
 * of the same mistake: render the row and look at what the dot actually got.
 * Asserted against `SEV_DOT.good` rather than a literal step, so a re-measure
 * that moves the step moves this with it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SeriesRow from '../SeriesRow'
import { SEV_DOT } from '../../board/tokens'

const SERIES = {
  id: 4, client_id: 9, title: 'Sweet — Biweekly', address: '12 Pine St',
  frequency: 'biweekly', interval_weeks: 2, days_of_week: [1],
  start_time: '09:00:00', end_time: '12:00:00', active: true,
  anchor_date: '2026-06-02', upcoming_job_count: 4,
}

function mount(over = {}) {
  return render(
    <MemoryRouter>
      <SeriesRow s={{ ...SERIES, ...over }} clientName="Anna Sweet" onOpen={() => {}} />
    </MemoryRouter>,
  )
}

/** The leading status dot: the first `rounded-full` span in the row. */
const dot = (container) => container.querySelector('span.rounded-full')

afterEach(cleanup)

describe('SeriesRow status dot', () => {
  it('gives a live series a dot that actually carries a colour', () => {
    const { container } = mount()
    expect(screen.getByText('Active')).toBeTruthy()
    const cls = dot(container).className
    // The assertion that would have caught the shipped bug: a real utility,
    // not the literal text of an un-evaluated template.
    expect(cls).not.toContain('${')
    for (const token of SEV_DOT.good.split(/\s+/)) expect(cls).toContain(token)
  })

  it('gives an ended series the quiet ink dot, not the live one', () => {
    // Active-but-past-its-end-date is how a split retires its predecessor, so
    // this is the common case rather than an edge one.
    const { container } = mount({ series_end_date: '2020-01-01' })
    expect(screen.getByText('Ended')).toBeTruthy()
    const cls = dot(container).className
    expect(cls).toContain('bg-ink-3')
    expect(cls).not.toContain('${')
    expect(cls).not.toContain('emerald')
  })

  it('names no next visit for a series that has ended', () => {
    // `computeUpcoming` does not read series_end_date, so it happily projects
    // dates past the end of the series; the row is only correct because it
    // gates on `live`. Pinned because dropping that gate is a tidy-looking
    // edit that would promise the owner a visit nothing will generate.
    mount({ series_end_date: '2020-01-01' })
    expect(screen.queryByText(/Next /)).toBeNull()
  })
})
