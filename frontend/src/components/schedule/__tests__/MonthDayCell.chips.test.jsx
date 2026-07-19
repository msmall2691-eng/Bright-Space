import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MonthDayCell from '../MonthDayCell'

afterEach(cleanup)

const typeConfig = {
  residential: { dot: 'bg-blue-500', pill: 'bg-blue-50 border-blue-200', pillHover: '' },
  str_turnover: { dot: 'bg-amber-500', pill: 'bg-amber-50 border-amber-200', pillHover: '' },
}
const noop = () => {}

function renderCell(dayJobs) {
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
    />
  )
}

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
