/**
 * Dragging a RECURRING job on the month grid used to fire a bare
 * PATCH /api/jobs/{id} with no scope prompt — silently corrupting the series
 * (duplicate on the old date, moved job flagged off-cadence). It must now
 * interrupt the drop with the same scope dialog WeekGrid + JobEditModal use,
 * and route through the recurring endpoints. A one-off job still moves directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

// Mock the roster + viewport hooks (as CalendarView.today.test does) so the
// component renders deterministically in desktop mode with no async roster
// fetch. MonthDayCell stays REAL — we need its draggable chip for the drag.
vi.mock('../../api', () => ({ get: vi.fn().mockResolvedValue([]), patch: vi.fn(), post: vi.fn() }))
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import { patch, post } from '../../api'
import CalendarView from '../CalendarView'

afterEach(cleanup)
beforeEach(() => { patch.mockReset(); post.mockReset() })

// Must cover the whole month GRID, which spills into late Dec 2025 for Jan 2026.
const WIDE_RANGE = { start: '2025-01-01', end: '2026-12-31' }
const ANCHOR = new Date(2026, 0, 15)   // January 2026
const SOURCE = '2026-01-07'            // Wednesday
const TARGET = '2026-01-08'            // Thursday

const job = (over = {}) => ({
  id: 1, title: 'Weekly clean', client_name: 'Weekly clean', status: 'scheduled',
  scheduled_date: SOURCE, start_time: '09:00', end_time: '11:00',
  job_type: 'residential', recurring_schedule_id: 42, cleaner_ids: [], ...over,
})

const makeDT = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') })

function renderCal(jobs) {
  return render(
    <CalendarView
      anchorDate={ANCHOR} parentJobs={jobs} parentRange={WIDE_RANGE}
      toast={{ success: vi.fn(), error: vi.fn() }}
      onJobClick={() => {}} onCreateForDay={() => {}}
      onLocalMove={vi.fn()} onRefresh={vi.fn()}
    />
  )
}

function dragChipToCell(container, chipText, targetDate) {
  const chip = screen.getByText(chipText).closest('[draggable="true"]')
  const cell = container.querySelector(`[data-day-cell="${targetDate}"]`)
  const dt = makeDT()
  fireEvent.dragStart(chip, { dataTransfer: dt })
  fireEvent.dragOver(cell, { dataTransfer: dt })
  fireEvent.drop(cell, { dataTransfer: dt })
}

describe('CalendarView — dragging a recurring job', () => {
  it('opens the scope dialog instead of PATCHing the job directly', async () => {
    const { container } = renderCal([job()])
    dragChipToCell(container, 'Weekly clean', TARGET)
    await waitFor(() => expect(screen.getByText('This is a repeating visit')).toBeTruthy())
    expect(patch).not.toHaveBeenCalledWith(expect.stringContaining('/api/jobs/'), expect.anything())
  })

  it('"This visit only" hits the reschedule-exception endpoint, not a bare job PATCH', async () => {
    post.mockResolvedValue({ job_id: 99 })
    const { container } = renderCal([job()])
    dragChipToCell(container, 'Weekly clean', TARGET)
    await waitFor(() => expect(screen.getByText('This is a repeating visit')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/recurring/42/reschedule',
      expect.objectContaining({ exception_date: SOURCE, rescheduled_date: TARGET })
    ))
    expect(patch).not.toHaveBeenCalledWith(expect.stringContaining('/api/jobs/'), expect.anything())
  })

  it('a one-off job still moves directly with a bare PATCH, no dialog', async () => {
    patch.mockResolvedValue({})
    const { container } = renderCal([job({ recurring_schedule_id: null })])
    dragChipToCell(container, 'Weekly clean', TARGET)
    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/1', expect.objectContaining({ scheduled_date: TARGET })
    ))
    expect(screen.queryByText('This is a repeating visit')).toBeNull()
  })
})
