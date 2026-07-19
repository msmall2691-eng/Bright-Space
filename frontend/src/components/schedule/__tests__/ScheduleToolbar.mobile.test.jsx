import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ScheduleToolbar from '../ScheduleToolbar'

afterEach(cleanup)

// jsdom doesn't apply Tailwind, so BOTH the phone (md:hidden) and desktop
// (hidden md:flex) layouts are in the DOM at once. These assertions use
// selectors that are UNIQUE to the phone layout — the icon-only "New job"
// (aria-label) and the amber sync-alert pill (data-testid) — so they pin the
// mobile redesign specifically.

const baseProps = {
  viewMode: 'month',
  onViewChange: vi.fn(),
  currentDate: '2026-07-20',
  onPrevWeek: vi.fn(),
  onNextWeek: vi.fn(),
  showFilters: false,
  onToggleFilters: vi.fn(),
  selectedPropertyType: 'all',
  onPropertyTypeChange: vi.fn(),
  selectedStatus: 'all',
  onStatusChange: vi.fn(),
  toolsOpen: false,
  onToggleTools: vi.fn(),
  onCloseTools: vi.fn(),
  onSyncNow: vi.fn(),
  onPreviewAutoAssign: vi.fn(),
  onPreviewFixTimes: vi.fn(),
  onNewJob: vi.fn(),
}

describe('ScheduleToolbar — phone layout', () => {
  it('gives the phone a dedicated icon-only New Job button', () => {
    const onNewJob = vi.fn()
    render(<ScheduleToolbar {...baseProps} onNewJob={onNewJob} />)
    fireEvent.click(screen.getByLabelText('New job'))
    expect(onNewJob).toHaveBeenCalled()
  })

  it('shows the amber sync-alert pill only when items are out of sync', () => {
    const onFixSync = vi.fn()
    const { rerender } = render(
      <ScheduleToolbar {...baseProps} syncAlertCount={0} onFixSync={onFixSync} />)
    expect(screen.queryByTestId('mobile-sync-alert')).toBeNull()

    rerender(<ScheduleToolbar {...baseProps} syncAlertCount={16} onFixSync={onFixSync} />)
    const pill = screen.getByTestId('mobile-sync-alert')
    expect(pill.textContent).toContain('16')
    fireEvent.click(pill)
    expect(onFixSync).toHaveBeenCalled()
  })

  it('hides the week date-nav in month view (wrong axis for a month grid)', () => {
    render(<ScheduleToolbar {...baseProps} viewMode="month" />)
    // "Previous" is the phone date-nav label; month view drops it.
    expect(screen.queryByLabelText('Previous')).toBeNull()
  })

  it('shows the date-nav in a non-month view and steps weeks', () => {
    const onNextWeek = vi.fn()
    render(<ScheduleToolbar {...baseProps} viewMode="agenda" onNextWeek={onNextWeek} />)
    fireEvent.click(screen.getByLabelText('Next'))
    expect(onNextWeek).toHaveBeenCalled()
  })
})
