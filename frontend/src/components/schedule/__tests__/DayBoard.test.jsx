/**
 * DayBoard is the desktop "Day" view that replaced the old drag-to-assign
 * dispatch board. The whole point of the replacement is that it is READ-ONLY:
 * the office no longer assigns a cleaner to a job (marketplace Rule 0), so a
 * block on the timeline is a tap-through to the job, never a thing you drag
 * onto a crew. These tests pin that — a block must not be draggable, and
 * tapping it opens the job.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import DayBoard from '../DayBoard'
import { todayYMD } from '../../../utils/format'

afterEach(cleanup)

const TODAY = todayYMD()

const props = (over = {}) => ({
  currentDate: new Date(`${TODAY}T00:00`),
  todayVisits: [
    { id: 1, job_id: 10, scheduled_date: TODAY, start_time: '09:00:00', end_time: '11:00:00', status: 'scheduled', cleaner_ids: ['c1'] },
    { id: 2, job_id: 11, scheduled_date: TODAY, start_time: '13:00:00', end_time: '15:00:00', status: 'scheduled', cleaner_ids: [] },
  ],
  todayStats: { jobs: 2, unassigned: 1, capacityPct: 50, crewsOut: 1 },
  jobs: {
    10: { id: 10, title: 'Clean Alice', property_id: 100, client_id: 1000, job_type: 'residential' },
    11: { id: 11, title: 'Turnover Bob', property_id: 101, client_id: 1001, job_type: 'str_turnover' },
  },
  properties: {
    100: { id: 100, property_type: 'residential' },
    101: { id: 101, property_type: 'str' },
  },
  clients: { 1000: { id: 1000, name: 'Alice' }, 1001: { id: 1001, name: 'Bob' } },
  empName: (id) => (id === 'c1' ? 'Dana' : ''),
  onOpen: vi.fn(),
  ...over,
})

describe('DayBoard (read-only Day view)', () => {
  it('lays the day out by time — every block is present', () => {
    render(<DayBoard {...props()} />)
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('renders the ops summary line above the timeline', () => {
    render(<DayBoard {...props()} />)
    expect(screen.getByText('jobs')).toBeTruthy()
    expect(screen.getByText('need a crew')).toBeTruthy()
  })

  it('is read-only: no block is draggable (the office never assigns)', () => {
    const { container } = render(<DayBoard {...props()} />)
    const blocks = [...container.querySelectorAll('button')].filter(b =>
      /Alice|Bob/.test(b.textContent))
    expect(blocks.length).toBe(2)
    for (const b of blocks) {
      // draggable={!!onDragStartVisit}; DayBoard passes no drag props, so the
      // attribute is false — a regression that re-wires drag would flip this.
      expect(b.getAttribute('draggable')).toBe('false')
    }
  })

  it('tapping a block opens that job', () => {
    const p = props()
    render(<DayBoard {...p} />)
    fireEvent.click(screen.getByText('Alice'))
    expect(p.onOpen).toHaveBeenCalledTimes(1)
    const [visit, job] = p.onOpen.mock.calls[0]
    expect(visit.id).toBe(1)
    expect(job.id).toBe(10)
  })
})
