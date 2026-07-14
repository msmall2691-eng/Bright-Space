/**
 * Pins the July-2026 audit finding #5: CalendarView used to derive "today"
 * from `now` (the ANCHOR — whichever month/day the schedule view happened to
 * be pointed at via the `anchorDate` prop) instead of the real wall-clock
 * date. That put the Today highlight on the anchor day instead of the actual
 * current day, and made the "Today" button a no-op once `now` and the
 * displayed month already matched — it just recomputed from the same stale
 * anchor instead of jumping to the real today
 * (`components/CalendarView.jsx`, `realToday` vs `now`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn().mockResolvedValue([]), patch: vi.fn() }))
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))
vi.mock('../schedule/MonthDayCell', () => ({
  default: ({ date, isToday, onSelectDay }) => (
    <div
      data-testid={`day-${date}`}
      data-today={isToday ? '1' : '0'}
      onClick={() => onSelectDay(date)}
    />
  ),
}))

import CalendarView from '../CalendarView'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('CalendarView — Today reflects the real date, not the anchor (audit #5)', () => {
  it('marks the actual current day, not the anchorDate day, as isToday', async () => {
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)) // July 15, 2026

    let utils
    await act(async () => {
      utils = render(<CalendarView anchorDate={new Date(2026, 6, 1, 12, 0, 0)} />)
      await vi.runAllTimersAsync()
    })
    const { getByTestId } = utils

    expect(getByTestId('day-2026-07-15').getAttribute('data-today')).toBe('1')
    expect(getByTestId('day-2026-07-01').getAttribute('data-today')).toBe('0')
  })

  it('"Today" button jumps back to the real current month, not the anchor month', async () => {
    vi.setSystemTime(new Date(2026, 6, 12, 12, 0, 0)) // July 12, 2026

    let utils
    await act(async () => {
      utils = render(<CalendarView anchorDate={new Date(2026, 2, 10, 12, 0, 0)} />) // March 2026
      await vi.runAllTimersAsync()
    })
    const { getByText, getByTestId } = utils

    expect(getByText('March 2026')).toBeTruthy()

    await act(async () => {
      fireEvent.click(getByText('Today'))
      await vi.runAllTimersAsync()
    })

    expect(getByText('July 2026')).toBeTruthy()
    expect(getByTestId('day-2026-07-12').getAttribute('data-today')).toBe('1')
  })
})
