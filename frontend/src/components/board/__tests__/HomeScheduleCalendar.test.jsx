import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// Capture the props the wrapper hands the real calendar, without rendering the
// heavy CalendarView itself.
let lastProps = null
vi.mock('../../CalendarView', () => ({
  default: (props) => { lastProps = props; return <div data-testid="calendarview-stub" /> },
}))

// Drive the data hook so the wrapper's wiring is deterministic.
const hookState = { value: {} }
vi.mock('../../../hooks/useScheduleData', () => ({
  useScheduleData: () => hookState.value,
}))

import HomeScheduleCalendar from '../HomeScheduleCalendar'

const navigate = vi.fn()

beforeEach(() => {
  lastProps = null
  hookState.value = {
    jobs: { 7: { id: 7, scheduled_date: '2026-09-20' }, 9: { id: 9 } },
    setJobs: vi.fn(), setVisits: vi.fn(),
    refresh: vi.fn(), range: { start: '2026-08-31', end: '2026-10-04' },
    loadError: false,
  }
})
afterEach(() => { cleanup(); navigate.mockReset() })

describe('HomeScheduleCalendar', () => {
  it('mounts the real CalendarView with the schedule data', () => {
    render(<HomeScheduleCalendar navigate={navigate} />)
    expect(screen.getByTestId('calendarview-stub')).toBeTruthy()
    // parentJobs is the jobs MAP flattened to an array.
    expect(lastProps.parentJobs.map(j => j.id).sort()).toEqual([7, 9])
    // The loaded range is handed through so CalendarView skips its own fetch.
    expect(lastProps.parentRange).toEqual({ start: '2026-08-31', end: '2026-10-04' })
    // Overlays stay off Home to keep it light.
    expect(lastProps.showGuestStays).toBe(false)
  })

  it('routes edits to where the full machinery lives', () => {
    render(<HomeScheduleCalendar navigate={navigate} />)
    lastProps.onJobClick({ id: 42 })
    expect(navigate).toHaveBeenCalledWith('/jobs/42')
    lastProps.onCreateForDay(new Date(2026, 8, 20))
    expect(navigate).toHaveBeenCalledWith('/schedule?date=2026-09-20')
  })

  it('"Open full schedule" jumps to the Schedule page', () => {
    render(<HomeScheduleCalendar navigate={navigate} />)
    fireEvent.click(screen.getByText(/open full schedule/i))
    expect(navigate).toHaveBeenCalledWith('/schedule')
  })

  it('optimistic move patches both the visits list and the jobs map', () => {
    render(<HomeScheduleCalendar navigate={navigate} />)
    lastProps.onLocalMove(7, { scheduled_date: '2026-09-25' })
    expect(hookState.value.setVisits).toHaveBeenCalled()
    expect(hookState.value.setJobs).toHaveBeenCalled()
  })

  it('shows a retry affordance on load error', () => {
    hookState.value = { ...hookState.value, loadError: true }
    render(<HomeScheduleCalendar navigate={navigate} />)
    expect(screen.queryByTestId('calendarview-stub')).toBeNull()
    fireEvent.click(screen.getByText(/retry/i))
    expect(hookState.value.refresh).toHaveBeenCalled()
  })
})
