/**
 * Drag-assign: dragging a visit card out of UnassignedQueue or a block out
 * of DispatchTimeline and dropping it on a crew card in CrewUtilization
 * assigns that visit to that cleaner (PATCH /api/jobs/{id} cleaner_ids).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ patch: vi.fn() }))

import { patch } from '../../../api'
import DispatchBoard from '../DispatchBoard'

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

function makeDataTransfer() {
  return { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') }
}

function dragVisitToCrew(sourceEl, crewId) {
  const crewCard = screen.getByTestId(`crew-card-${crewId}`)
  const dataTransfer = makeDataTransfer()
  fireEvent.dragStart(sourceEl, { dataTransfer })
  fireEvent.dragOver(crewCard, { dataTransfer })
  fireEvent.drop(crewCard, { dataTransfer })
}

const unassignedVisit = {
  id: 1, job_id: 1, status: 'scheduled',
  scheduled_date: '2026-01-07', start_time: '09:00', end_time: '11:00',
  cleaner_ids: [],
}

const assignedVisit = {
  id: 2, job_id: 2, status: 'scheduled',
  scheduled_date: '2026-01-07', start_time: '13:00', end_time: '15:00',
  cleaner_ids: ['emp1'],
}

const CREW_LOAD = [
  { id: 'emp1', hours: 2, capacityPct: 25, visits: [assignedVisit] },
  { id: 'emp2', hours: 0, capacityPct: 0, visits: [] },
]

const baseProps = {
  currentDate: new Date(2026, 0, 7),
  todayVisits: [unassignedVisit, assignedVisit],
  todayStats: { jobs: 2, unassigned: 1, capacityPct: 20, crewsOut: 1, hours: 4 },
  unassignedToday: [unassignedVisit],
  crewLoad: CREW_LOAD,
  jobs: { 1: unassignedVisit, 2: assignedVisit },
  properties: {},
  clients: {},
  empName: (id) => ({ emp1: 'Alice', emp2: 'Bob' }[id] || id),
  onOpen: vi.fn(),
}

describe('DispatchBoard — drag-assign', () => {
  it('dragging an unassigned visit onto a crew card assigns it', async () => {
    patch.mockResolvedValue({})
    const onLocalMove = vi.fn()
    render(<DispatchBoard {...baseProps} onLocalMove={onLocalMove} />)

    // "Visit 1" renders in both the UnassignedQueue card and its own (unassigned)
    // DispatchTimeline block — grab the queue card, which is first in the DOM.
    const card = screen.getAllByText('Visit 1')[0].closest('button')
    dragVisitToCrew(card, 'emp2')

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/1',
      expect.objectContaining({ cleaner_ids: ['emp2'] })
    ))
    expect(onLocalMove).toHaveBeenCalledWith(1, { cleaner_ids: ['emp2'] })
  })

  it('dragging an already-assigned block onto a different crew reassigns it', async () => {
    patch.mockResolvedValue({})
    render(<DispatchBoard {...baseProps} />)

    const block = screen.getByText('Visit 2').closest('button')
    dragVisitToCrew(block, 'emp2')

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/api/jobs/2',
      expect.objectContaining({ cleaner_ids: ['emp2'] })
    ))
  })

  it('dropping on the crew that already has the visit is a no-op', async () => {
    render(<DispatchBoard {...baseProps} />)

    const block = screen.getByText('Visit 2').closest('button')
    dragVisitToCrew(block, 'emp1')

    // give any async handler a tick to fire, then assert nothing happened
    await new Promise(r => setTimeout(r, 0))
    expect(patch).not.toHaveBeenCalled()
  })

  it('reverts the optimistic assignment and shows a retry action on 409', async () => {
    const conflictErr = Object.assign(new Error('double-booked'), { status: 409, detail: 'double-booked' })
    patch.mockRejectedValueOnce(conflictErr)
    const onLocalMove = vi.fn()
    const toast = { success: vi.fn(), error: vi.fn() }
    render(<DispatchBoard {...baseProps} onLocalMove={onLocalMove} toast={toast} />)

    // "Visit 1" renders in both the UnassignedQueue card and its own (unassigned)
    // DispatchTimeline block — grab the queue card, which is first in the DOM.
    const card = screen.getAllByText('Visit 1')[0].closest('button')
    dragVisitToCrew(card, 'emp2')

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // First call optimistically assigns, second call (after the 409) reverts to the original.
    expect(onLocalMove).toHaveBeenNthCalledWith(1, 1, { cleaner_ids: ['emp2'] })
    expect(onLocalMove).toHaveBeenNthCalledWith(2, 1, { cleaner_ids: [] })
  })
})
