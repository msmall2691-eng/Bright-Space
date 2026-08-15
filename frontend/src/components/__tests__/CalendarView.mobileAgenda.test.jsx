/**
 * Phone month view — the selected day's agenda renders INLINE below the
 * grid, not in a fixed bottom-sheet overlay. The old overlay was sized in
 * vh (which ignores the iOS Safari URL bar), rendered taller than the
 * visible viewport, and trapped scrolling — the owner's "I click on the
 * day, and then I can't scroll" report. These tests pin the replacement:
 *   1. today is auto-selected on phones, so the agenda shows jobs with
 *      NO tap at all ("I can't see anything til I click on the day"),
 *   2. no fixed-position overlay/backdrop is ever mounted at phone width,
 *   3. tapping another day repopulates the same inline agenda.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('../../api', () => ({ get: vi.fn().mockResolvedValue([]), patch: vi.fn() }))
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => true }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))
vi.mock('../schedule/MonthDayCell', () => ({
  default: ({ date, isSelected, onSelectDay }) => (
    <div
      data-testid={`day-${date}`}
      data-selected={isSelected ? '1' : '0'}
      onClick={() => onSelectDay(date)}
    />
  ),
}))

import CalendarView from '../CalendarView'

const JOBS = [
  {
    id: 1, title: 'Shore Rd deep clean', client_name: 'Anna Doyle',
    job_type: 'residential', status: 'scheduled', scheduled_date: '2026-07-15',
    start_time: '09:00', end_time: '11:00', address: '12 Shore Rd, Portland',
    cleaner_ids: [],
  },
  {
    id: 2, title: 'Keystone turnover', client_name: 'Bill Mercer',
    job_type: 'str_turnover', status: 'completed', scheduled_date: '2026-07-18',
    start_time: '10:00', end_time: '13:00', address: '4 Keystone Dr',
    cleaner_ids: [],
  },
]
// Covers the whole July 2026 grid so CalendarView skips its own jobs fetch.
const RANGE = { start: '2026-06-28', end: '2026-08-01' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)) // July 15, 2026
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

async function renderMobile() {
  let utils
  await act(async () => {
    utils = render(
      <CalendarView
        anchorDate={new Date(2026, 6, 1, 12, 0, 0)}
        parentJobs={JOBS}
        parentRange={RANGE}
      />
    )
    await vi.runAllTimersAsync()
  })
  return utils
}

describe('CalendarView — phone inline day agenda', () => {
  it("auto-selects today so today's jobs are visible without a tap", async () => {
    const { getByTestId, getByText } = await renderMobile()

    expect(getByTestId('day-2026-07-15').getAttribute('data-selected')).toBe('1')
    // The inline agenda shows the job card: title, time, address, client.
    expect(getByText('Shore Rd deep clean')).toBeTruthy()
    expect(getByText('12 Shore Rd, Portland')).toBeTruthy()
  })

  it('never mounts a fixed overlay/backdrop at phone width', async () => {
    const { container } = await renderMobile()
    expect(container.querySelector('.fixed.inset-0')).toBeNull()
    // The agenda flows with the page — no viewport-height cap on it.
    expect(container.innerHTML).not.toContain('75vh')
  })

  it('tapping another day repopulates the inline agenda (no modal)', async () => {
    const { getByTestId, getByText, queryByText, container } = await renderMobile()

    await act(async () => {
      fireEvent.click(getByTestId('day-2026-07-18'))
      await vi.runAllTimersAsync()
    })

    expect(getByTestId('day-2026-07-18').getAttribute('data-selected')).toBe('1')
    expect(getByText('Keystone turnover')).toBeTruthy()
    expect(queryByText('Shore Rd deep clean')).toBeNull()
    // Status reads as quiet dot + word.
    expect(getByText('Done')).toBeTruthy()
    expect(container.querySelector('.fixed.inset-0')).toBeNull()
  })
})
