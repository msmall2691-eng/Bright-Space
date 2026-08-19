/**
 * Pins the July-2026 audit finding #5: Schedule.jsx used to early-return a
 * tab panel for ?tab=recurring / ?tab=availability BEFORE ~20 of its hooks
 * were declared — a Rules-of-Hooks violation. React ties each hook's internal
 * state to its call INDEX within the component; skipping hooks on one render
 * and running them on the next (e.g. navigating from ?tab=recurring back to
 * the normal schedule view without unmounting) throws "Rendered more hooks
 * than during the previous render" / corrupts hook state silently, depending
 * on the exact mismatch. (?tab=recurring itself was later replaced with a
 * redirect to the dedicated /recurring page — see the test below — but the
 * early-return-before-hooks hazard the suite guards against is general.)
 *
 * These tests mock every hook/child component Schedule.jsx depends on (it's
 * a large page component) so we can isolate the ONE thing under test: does
 * mounting on ?tab=recurring, then re-rendering the SAME instance with the
 * tab param removed, survive without React throwing?
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'

vi.mock('../../api', () => ({ get: vi.fn().mockResolvedValue([]), post: vi.fn(), put: vi.fn(), patch: vi.fn() }))
vi.mock('../../components/ui/Toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() }, ToastContainer: () => null }),
}))
vi.mock('../../hooks/useScheduleData', () => ({
  useScheduleData: () => ({
    visits: [], setVisits: vi.fn(),
    jobs: {}, setJobs: vi.fn(),
    properties: {}, clients: {},
    loading: false, loadError: null,
    refresh: vi.fn(),
    employees: [], empName: () => '',
    range: null,
  }),
}))
vi.mock('../../hooks/useScheduleAnalytics', () => ({
  useScheduleAnalytics: () => ({
    weekDates: [], loadByDate: {}, todayVisits: [], todayStats: {},
    crewLoad: [], unassignedToday: [],
  }),
}))
vi.mock('../../hooks/useScheduleTools', () => ({
  useScheduleTools: () => ({
    syncingNow: false, syncNow: vi.fn(),
    fixingSync: false, fixSync: vi.fn(),
    autoAssign: null, setAutoAssign: vi.fn(), previewAutoAssign: vi.fn(), runAutoAssign: vi.fn(),
    fixTimes: null, setFixTimes: vi.fn(), previewFixTimes: vi.fn(), runFixTimes: vi.fn(),
  }),
}))
vi.mock('../../hooks/useScheduleFilters', () => ({
  useScheduleFilters: () => ({
    selectedPropertyType: 'all', setSelectedPropertyType: vi.fn(),
    selectedStatus: 'all', setSelectedStatus: vi.fn(),
    unassignedOnly: false, setUnassignedOnly: vi.fn(),
    noGcalOnly: false, setNoGcalOnly: vi.fn(),
    filteredVisits: [], unassignedCount: 0, visitsByDate: {}, scheduleStats: {},
    currentlyVisibleVisits: [],
  }),
}))
vi.mock('../../hooks/useVisitSelection', () => ({
  useVisitSelection: () => ({
    selectedVisitIds: new Set(), toggleVisitSelect: vi.fn(), selectAllVisible: vi.fn(),
    clearVisitSelection: vi.fn(), bulkDeleteVisits: vi.fn(), bulkDeleting: false,
    bulkShiftVisits: vi.fn(), bulkShifting: false,
  }),
}))
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

// Child components stubbed to trivial markers so we can assert which branch
// rendered without pulling in their own (large) dependency trees.
vi.mock('../../components/ui/Button', () => ({ default: () => null }))
vi.mock('../../components/ui/ErrorState', () => ({ default: () => null }))
vi.mock('../../components/JobEditModal', () => ({ default: () => null }))
vi.mock('../../components/JobCreateModal', () => ({ default: () => null }))
vi.mock('../../components/CalendarView', () => ({ default: () => <div data-testid="calendar-view" /> }))
vi.mock('../../components/schedule/AgendaDay', () => ({ default: () => null }))
vi.mock('../../components/schedule/AgendaHero', () => ({ default: () => null }))
vi.mock('../../components/schedule/DispatchBoard', () => ({ default: () => <div data-testid="dispatch-board" /> }))
vi.mock('../../components/schedule/StickyActionBar', () => ({ default: () => null }))
vi.mock('../../components/schedule/WeekGrid', () => ({ default: () => null }))
vi.mock('../../components/schedule/ScheduleSkeleton', () => ({ default: () => null }))
vi.mock('../../components/schedule/CompleteVisitModal', () => ({ default: () => null }))
vi.mock('../../components/schedule/VisitDetailsDrawer', () => ({ default: () => null }))
vi.mock('../../components/schedule/ScheduleToolbar', () => ({ default: () => <div data-testid="schedule-toolbar" /> }))
vi.mock('../../components/schedule/PowerToolModals', () => ({ AutoAssignModal: () => null, FixTimesModal: () => null }))
vi.mock('../../components/schedule/ScheduleSections', () => ({ ScheduleHealthStrip: () => null, ScheduleBulkBar: () => null }))
vi.mock('../../components/schedule/ScheduleTabs', () => ({
  AvailabilityPanel: () => <div data-testid="availability-panel" />,
}))

import Schedule from '../Schedule'

afterEach(cleanup)

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/schedule" element={<Schedule />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('Schedule.jsx — hooks order across ?tab= transitions (audit #5)', () => {
  it('redirects ?tab=recurring to the dedicated /recurring page (still below all hooks)', () => {
    // Recurring management was consolidated onto /recurring; the legacy tab now
    // early-returns <Navigate to="/recurring">. It still sits below every hook,
    // so the audit-#5 hooks-order guarantee is preserved.
    const { getByTestId } = render(
      <MemoryRouter initialEntries={['/schedule?tab=recurring']}>
        <Routes>
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/recurring" element={<div data-testid="recurring-page" />} />
        </Routes>
      </MemoryRouter>
    )
    expect(getByTestId('recurring-page')).toBeTruthy()
  })

  it('renders AvailabilityPanel for ?tab=availability without throwing', () => {
    const { getByTestId } = renderAt('/schedule?tab=availability')
    expect(getByTestId('availability-panel')).toBeTruthy()
  })

  it('renders the normal schedule toolbar with no ?tab= param', () => {
    const { getByTestId } = renderAt('/schedule?view=dispatch')
    expect(getByTestId('schedule-toolbar')).toBeTruthy()
  })

  it('surviving a tab->no-tab transition on the SAME mounted instance does not throw a hooks-order error', () => {
    // This is the crux of the bug: switching the URL from ?tab=recurring to
    // the normal view WITHOUT unmounting Schedule used to change how many
    // hooks ran between renders. React throws synchronously ("Rendered more
    // hooks than during the previous render") when that happens — a caught
    // exception here means the fix regressed, not just a wrong screen
    // showing. MemoryRouter's `initialEntries` is read once on mount only,
    // so a fresh MemoryRouter on rerender would NOT actually simulate
    // in-place navigation — we drive a real history push via useNavigate()
    // inside the same mounted router instance instead.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    function Harness() {
      const navigate = useNavigate()
      return (
        <>
          <button data-testid="go-to-dispatch" onClick={() => navigate('/schedule?view=dispatch')} />
          <Schedule />
        </>
      )
    }

    let getByTestId
    expect(() => {
      // Use ?tab=availability — it early-returns a panel IN PLACE (no route
      // change), so we genuinely exercise a same-instance tab->no-tab render
      // transition. (?tab=recurring now redirects away, which would unmount.)
      const utils = render(
        <MemoryRouter initialEntries={['/schedule?tab=availability']}>
          <Routes>
            <Route path="/schedule" element={<Harness />} />
          </Routes>
        </MemoryRouter>
      )
      getByTestId = utils.getByTestId
      // Confirm we actually started on the tab branch before navigating.
      expect(getByTestId('availability-panel')).toBeTruthy()
      fireEvent.click(getByTestId('go-to-dispatch'))
      // If hook order broke, React throws synchronously inside this click's
      // render pass — reaching the next assertion means it survived.
      expect(getByTestId('schedule-toolbar')).toBeTruthy()
    }).not.toThrow()

    const hooksOrderError = consoleError.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && /hook/i.test(a) && /order|more hooks|fewer hooks/i.test(a))
    )
    expect(hooksOrderError).toBe(false)
    consoleError.mockRestore()
  })
})
