import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MonthDayCell from '../MonthDayCell'

afterEach(cleanup)

const typeConfig = {
  residential: { dot: 'bg-blue-500', pill: 'bg-blue-50 border-blue-200', pillHover: '' },
  str_turnover: { dot: 'bg-amber-500', pill: 'bg-amber-50 border-amber-200', pillHover: '' },
}
const noop = () => {}

function renderCell(dayJobs, extra = {}) {
  return render(
    <MonthDayCell
      date="2026-07-15" dayJobs={dayJobs}
      dayBookings={[]} daySkips={[]} dayReschedFrom={[]} dayReschedTo={[]}
      isToday={false} isSelected={false} isDropTarget={false} isCheckin={false} isCheckout={false}
      isMobile={false} maxPills={4} typeConfig={typeConfig}
      cleanerFor={(j) => (j.cleaner_ids?.length ? { count: j.cleaner_ids.length, initials: 'JD' } : null)}
      onSelectDay={noop} onDragOverDay={noop} onDragLeaveDay={noop} onDropDay={noop}
      onChipDragStart={noop} onChipDragEnd={noop}
      onChipTouchStart={noop} onChipTouchMove={noop} onChipTouchEnd={noop} onChipTouchCancel={noop}
      onJobClick={noop} justDraggedRef={{ current: false }}
      {...extra}
    />
  )
}

const jobsN = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, job_type: 'residential', start_time: `0${(i % 8) + 1}:00:00`,
  client_name: `Client ${i + 1}`, status: 'scheduled', cleaner_ids: ['e1'],
}))

describe('MonthDayCell chips — cleaner at a glance', () => {
  it('shows the assigned cleaner initials on a chip', () => {
    renderCell([{ id: 1, job_type: 'residential', start_time: '09:00:00', client_name: 'Paul Day', status: 'scheduled', cleaner_ids: ['e1'] }])
    expect(screen.getByText('Paul Day')).toBeTruthy()
    expect(screen.getByText('JD')).toBeTruthy()
  })

  it('flags an unassigned job with a needs-a-cleaner marker', () => {
    renderCell([{ id: 2, job_type: 'str_turnover', start_time: '10:00:00', client_name: 'The Pier House', status: 'scheduled', cleaner_ids: [] }])
    expect(screen.getByText('The Pier House')).toBeTruthy()
    expect(screen.getByTitle('Needs a cleaner')).toBeTruthy()
  })

  it('shows +N when more than one cleaner is assigned', () => {
    renderCell([{ id: 3, job_type: 'residential', start_time: '09:00:00', client_name: 'Casey', status: 'scheduled', cleaner_ids: ['e1', 'e2'] }])
    expect(screen.getByText('JD+1')).toBeTruthy()
  })
})

describe('MonthDayCell — show everything (expand) + quick add', () => {
  it('caps a packed day and offers "+N more" that asks the parent to expand', () => {
    const onToggleMore = vi.fn()
    renderCell(jobsN(7), { onToggleMore })  // 7 jobs, cap 4
    expect(screen.getByText('Client 4')).toBeTruthy()
    expect(screen.queryByText('Client 5')).toBeNull()  // hidden while collapsed
    const more = screen.getByText('+3 more')
    fireEvent.click(more)
    expect(onToggleMore).toHaveBeenCalledWith('2026-07-15')
  })

  it('shows every job (no cap) when expanded, with a "Show less"', () => {
    renderCell(jobsN(7), { isExpanded: true })
    expect(screen.getByText('Client 5')).toBeTruthy()
    expect(screen.getByText('Client 7')).toBeTruthy()
    expect(screen.queryByText('+3 more')).toBeNull()
    expect(screen.getByText('Show less')).toBeTruthy()
  })

  it('quick-adds a job on the day via the hover "+"', () => {
    const onQuickAdd = vi.fn()
    renderCell(jobsN(1), { onQuickAdd })
    fireEvent.click(screen.getByLabelText('Add a job on 2026-07-15'))
    expect(onQuickAdd).toHaveBeenCalledWith('2026-07-15')
  })
})
