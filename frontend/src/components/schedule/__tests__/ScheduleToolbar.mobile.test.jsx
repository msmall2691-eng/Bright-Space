import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ScheduleToolbar from '../ScheduleToolbar'

afterEach(cleanup)

// jsdom doesn't apply Tailwind, so BOTH the phone (md:hidden) and desktop
// (hidden md:flex) layouts are in the DOM at once. These assertions use
// selectors that are UNIQUE to the phone layout — the icon-only "New job"
// (aria-label) — so they pin the mobile redesign specifically.
//
// The old amber "mobile-sync-alert" pill was replaced by <SyncHealthPill>,
// which fetches its own data; with no API in jsdom it renders null, so it's
// invisible here and covered by SyncHealthPill.test.jsx instead.

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
  it('drops the phone toolbar "+" — the bottom-right FAB is the one mobile primary', () => {
    // De-clutter: the icon-only "New job" (aria-label) that used to sit in the
    // phone toolbar was removed so there is ONE primary on a phone — the
    // bottom-right StickyActionBar FAB (its own component/test). The desktop
    // "New Job" text button (no aria-label) is the only New-Job control left in
    // this toolbar, so the phone-unique aria-label is gone.
    render(<ScheduleToolbar {...baseProps} />)
    expect(screen.queryByLabelText('New job')).toBeNull()
  })

  it('keeps the desktop New Job button wired to onNewJob', () => {
    const onNewJob = vi.fn()
    render(<ScheduleToolbar {...baseProps} onNewJob={onNewJob} />)
    fireEvent.click(screen.getByText('New Job'))
    expect(onNewJob).toHaveBeenCalled()
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
