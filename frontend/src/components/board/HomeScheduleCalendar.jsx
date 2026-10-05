import { useCallback, useMemo, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import CalendarView from '../CalendarView'
import { useScheduleData } from '../../hooks/useScheduleData'
import { toast } from '../../utils/toastBus'
import { toLocalYMD } from '../../utils/format'

/**
 * The REAL Schedule calendar, embedded on Home.
 *
 * Replaces the earlier read-only count grid (board/ScheduleCalendar). The owner
 * wanted Home to show the SAME schedule as the Schedule page — not a simplified
 * per-day count that quietly diverged (it dropped date-less turnovers, defaulted
 * to a one-week Monday-anchored window, and couldn't show the overlays the real
 * page does). So this mounts the actual <CalendarView> with the same data hook
 * the Schedule page uses (useScheduleData at the month range — correctly paged,
 * so no /api/jobs limit=500 truncation) and the same wiring.
 *
 * Drag-to-reschedule works because CalendarView persists the move itself (it
 * owns the recurring-aware reschedule call); onLocalMove is only the optimistic
 * patch that keeps a dragged chip from snapping back before the refetch, and
 * onRefresh reconciles — both mirrored from Schedule.jsx.
 *
 * The 3-minute poll (vs the hook's 45s default) is because Home is a glance
 * surface, not where two admins edit against each other — that's the Schedule
 * page, which keeps the default. At 45s this re-fetched the whole month 80
 * times an hour while the dashboard sat open. The hook refetches on returning
 * to the tab, so the slower interval costs no freshness at the moment anyone
 * actually looks (brightbase-economy).
 *
 * stackDayDetail is why the month grid stays legible here. Home puts this
 * calendar in a ~420px column at the owner's ~940px window; CalendarView's
 * day rail is a fixed 320px and gates itself on the VIEWPORT (useIsMobile /
 * md:), which on a full-width Schedule page is right and here is not. Opened
 * beside the grid it left ~100px of month and collapsed the weekday headers
 * into "SunMonTue". Stacked, the agenda sits under the grid the way it
 * already does on a phone. Keep it set while this lives in a column.
 *
 * The heavy edit machinery (VisitDetailsDrawer, JobEditModal) stays on the
 * Schedule page: clicking a job opens its detail page, and quick-add for a day
 * jumps to the Schedule pre-dated. Guest-stay / Google overlays are left off
 * Home to keep the dashboard's fetch budget light (brightbase-economy).
 */
export default function HomeScheduleCalendar({ navigate }) {
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const {
    jobs, setJobs, setVisits, refresh, range, loadError,
  } = useScheduleData(currentDate, 'month', { pollMs: 180000 })

  // CalendarView reads parentJobs as an array; the hook holds them as a map.
  const parentJobs = useMemo(() => Object.values(jobs || {}), [jobs])

  // Mirrors Schedule.jsx applyLocalMove: patch the visits list AND the jobs map
  // so a dragged chip holds its new day (CalendarView re-seeds from the jobs
  // map) until its own reschedule + refresh reconcile. WeekGrid/MonthGrid pass
  // { scheduled_date, start_time, end_time }.
  const applyLocalMove = useCallback((jobId, next) => {
    setVisits(prev => prev.map(v =>
      v.job_id === jobId || v.id === jobId ? { ...v, ...next } : v))
    setJobs(prev => (prev && prev[jobId])
      ? { ...prev, [jobId]: { ...prev[jobId], ...next } } : prev)
  }, [setJobs, setVisits])

  return (
    <section
      data-testid="home-schedule-calendar"
      className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none" aria-hidden="true">📅</span>
        <h2 className="text-[11px] font-medium text-ink-3">Schedule</h2>
        <button
          onClick={() => navigate('/schedule')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
          Open full schedule<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      {loadError ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load the schedule.</span>
          <button
            onClick={refresh}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-link hover:text-link">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      ) : (
        <div className="p-2 sm:p-3">
          <CalendarView
            parentJobs={parentJobs}
            parentRange={range}
            anchorDate={currentDate}
            onMonthChange={setCurrentDate}
            onLocalMove={applyLocalMove}
            onRefresh={refresh}
            filters={{}}
            toast={toast}
            onJobClick={(j) => navigate(`/jobs/${j.id}`)}
            onCreateForDay={(d) => navigate(`/schedule?date=${toLocalYMD(d)}`)}
            showGuestStays={false}
            stackDayDetail
          />
        </div>
      )}
    </section>
  )
}
