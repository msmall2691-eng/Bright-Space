/**
 * Dragging a recurring visit used to silently PATCH just that one Job — a
 * "this visit only" move with no indication the visit belonged to a series
 * (audit finding, July 2026). It must now interrupt the drop with the same
 * Jobber-parity scope dialog JobEditModal's save flow uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

import { post, patch } from '../../../api'
import WeekGrid from '../WeekGrid'
import { weekDaysContaining } from '../weekGridLayout'

afterEach(cleanup)

const CURRENT_DATE = new Date(2026, 0, 7) // a Wednesday
const DAYS = weekDaysContaining(CURRENT_DATE)
const SOURCE_DAY = DAYS[3] // Wednesday
const TARGET_DAY = DAYS[4] // Thursday

function makeDataTransfer() {
  return { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') }
}

function dragVisitToDay(visitId, targetDay) {
  const block = screen.getByTestId(`week-grid-block-${visitId}`)
  const targetBody = screen.getByTestId(`week-grid-day-${targetDay}`)
  const dataTransfer = makeDataTransfer()
  fireEvent.dragStart(block, { dataTransfer })
  fireEvent.dragOver(targetBody, { dataTransfer, clientY: 100 })
  fireEvent.drop(targetBody, { dataTransfer, clientY: 100 })
}

function recurringVisit(over = {}) {
  return {
    id: 1, job_id: 1, title: 'Weekly clean', status: 'scheduled',
    scheduled_date: SOURCE_DAY, start_time: '09:00', end_time: '11:00',
    recurring_schedule_id: 42, cleaner_ids: ['emp1'],
    ...over,
  }
}

describe('WeekGrid — dragging a recurring visit', () => {
  it('shows the scope dialog instead of PATCHing the job directly', async () => {
    const visit = recurringVisit()
    render(
      <WeekGrid currentDate={CURRENT_DATE} filteredVisits={[visit]} jobs={{ 1: visit }} />
    )

    dragVisitToDay(1, TARGET_DAY)

    await waitFor(() => expect(screen.getByText('This is a repeating visit')).toBeDefined())
    // The plain job PATCH must not have fired — only the recurring endpoints should.
    expect(patch).not.toHaveBeenCalledWith(expect.stringContaining('/api/jobs/'), expect.anything())
  })

  it('choosing "this visit only" calls the reschedule-exception endpoint, not a bare job PATCH', async () => {
    post.mockResolvedValue({ job_id: 99 })
    const visit = recurringVisit()
    render(
      <WeekGrid currentDate={CURRENT_DATE} filteredVisits={[visit]} jobs={{ 1: visit }} />
    )

    dragVisitToDay(1, TARGET_DAY)
    await waitFor(() => expect(screen.getByText('This is a repeating visit')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/recurring/42/reschedule',
      expect.objectContaining({ exception_date: SOURCE_DAY, rescheduled_date: TARGET_DAY })
    ))
  })

  it('a non-recurring visit still reschedules directly with no dialog', async () => {
    patch.mockResolvedValue({})
    const visit = recurringVisit({ recurring_schedule_id: null })
    render(
      <WeekGrid currentDate={CURRENT_DATE} filteredVisits={[visit]} jobs={{ 1: visit }} />
    )

    dragVisitToDay(1, TARGET_DAY)

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/1',
      expect.objectContaining({ scheduled_date: TARGET_DAY })
    ))
    expect(screen.queryByText('This is a repeating visit')).toBeNull()
  })
})
