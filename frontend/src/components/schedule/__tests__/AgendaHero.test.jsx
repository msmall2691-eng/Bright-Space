/**
 * AgendaHero — the phone "today at a glance" band now also surfaces the
 * "Needs a date" list.
 *
 * The gap it closes: accepted jobs with no date picked yet lived only on the
 * office (desktop) command bar, so on a phone they were invisible on the
 * Schedule page — you had to go to the dashboard or the job to set a date.
 * Pinned here: the hero renders the strip when there are undated jobs, and
 * renders nothing when there aren't (calm days stay calm).
 *
 * The sibling widgets (summary / date strip / alerts) are mocked to null so
 * this isolates AgendaHero's own composition; NeedsDateStrip stays real.
 */
import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../OpsSummary', () => ({ default: () => null }))
vi.mock('../DateStrip', () => ({ default: () => null }))
vi.mock('../OpsAlerts', () => ({ default: () => null }))
vi.mock('../DayActionButtons', () => ({ default: () => null }))

import AgendaHero from '../AgendaHero'

afterEach(cleanup)

const base = {
  currentDate: new Date('2026-10-03T12:00'),
  todayVisits: [], todayStats: {}, unassignedToday: [], awaitingReply: [],
  weekDates: [], loadByDate: {}, jobs: {}, properties: {},
  isToday: true, onDateSelect: () => {}, onFocusUnassigned: () => {},
  onOpenToCrew: () => {}, onSchedule: () => {},
}

const render_ = (props) =>
  render(<MemoryRouter><AgendaHero {...base} {...props} /></MemoryRouter>)

it('surfaces undated jobs on the phone hero', () => {
  render_({ unscheduled: [{ id: 7, client_name: 'Jane Cove' }] })
  expect(screen.getByText('Needs a date')).toBeTruthy()
  expect(screen.getByText('Jane Cove')).toBeTruthy()
})

it('shows no needs-a-date strip when there are none', () => {
  render_({ unscheduled: [] })
  expect(screen.queryByText('Needs a date')).toBeNull()
})
