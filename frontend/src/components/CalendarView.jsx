import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Home, RotateCw, X, ArrowRight, ArrowLeft, Ban, Zap, Users, ExternalLink, Plus } from 'lucide-react'
import { get, patch } from "../api"
import { toLocalYMD } from '../utils/format'
import { PROPERTY_TYPE_CONFIG } from './schedule/constants'
import { useIsMobile } from '../hooks/useIsMobile'
import { useEmployees } from '../hooks/useEmployees'
import { monthGridRange, rangeContains } from '../utils/dateRange'
import MonthDayCell from './schedule/MonthDayCell'


// Job-type styling comes from the shared PROPERTY_TYPE_CONFIG so a job is
// the same color here as it is in the agenda/list views (audit §8). The
// only local override is the label — month chips historically say
// "Turnover" instead of "STR" for job_type='str_turnover', because "STR"
// on a shift feels wrong out of context.
const TYPE_CONFIG = {
  ...PROPERTY_TYPE_CONFIG,
  str_turnover: { ...PROPERTY_TYPE_CONFIG.str_turnover, label: 'Turnover' },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

export function eachDay(start, end) {
  const days = []
  const cur = new Date(start + 'T12:00:00')
  const fin = new Date(end   + 'T12:00:00')
  if (isNaN(cur) || isNaN(fin)) return days
  // Hard cap: this runs per event per render, and a corrupt feed date (e.g.
  // a checkout in year 9999 from a bad iCal/GCal sync) must not lock the
  // renderer iterating millions of days. 400 covers any real stay/block.
  for (let i = 0; cur <= fin && i < 400; i++) {
    days.push(toLocalYMD(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return parts[0].slice(0, 2).toUpperCase()
}

// useIsMobile lives in ../hooks/useIsMobile now — shared with WeekGrid.

export default function CalendarView({
  onJobClick, onDayClick, onCreateForDay,
  refreshKey, filters = {}, toast,
  // Audit §16: parent-fed jobs + range. When rangeContains(parentRange,
  // this-month-grid) we skip the local /api/jobs fetch and render from
  // parentJobs. anchorDate tells us which month to open on (defaults to
  // "now" so this component still works standalone with no parent state).
  parentJobs, parentRange, anchorDate, onMonthChange,
  // Airbnb/VRBO iCal guest-stay overlay — off by default (Schedule.jsx
  // persists the operator's choice). When off, skip the fetch entirely
  // rather than fetching-then-hiding.
  showGuestStays = false,
}) {
  const now = anchorDate ? new Date(anchorDate) : new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())

  // Keep the internal year/month synced with anchorDate when the parent
  // moves. Two-way binding: the Prev/Next buttons below call onMonthChange
  // so the parent moves currentDate, then we re-render at the new month.
  useEffect(() => {
    if (!anchorDate) return
    const d = new Date(anchorDate)
    const y = d.getFullYear()
    const m = d.getMonth()
    if (y !== year || m !== month) {
      setYear(y)
      setMonth(m)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorDate])
  const [jobs,       setJobs]       = useState([])
  const [icalEvents, setIcalEvents] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [selected,   setSelected]   = useState(null)
  // Employees roster comes from the shared getCached() layer via
  // useEmployees; used by the day-panel cleaner drop-down (audit §18).
  const { employees } = useEmployees()
  // Audit §12: the month fetch used to fail silently (console.error only)
  // and the grid rendered blank until data arrived. Track loading + error
  // so we can show a skeleton on first load and a retry banner on failure.
  const [monthLoading, setMonthLoading] = useState(true)
  const [monthError,   setMonthError]   = useState(null)

  const [draggingJob, setDraggingJob] = useState(null)
  const [dropTarget, setDropTarget]   = useState(null)
  // Mirrors draggingJob so the drop handlers below can read its CURRENT
  // value without depending on the state itself (which would rebuild the
  // handler — and re-render every memoized day cell — on every drag start).
  const draggingJobRef = useRef(null)
  useEffect(() => { draggingJobRef.current = draggingJob }, [draggingJob])

  const isMobile = useIsMobile()
  const today = toLocalYMD(now)

  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const rangeStart = isoDate(year, month, 1)
  const rangeEnd   = isoDate(year, month, lastDay.getDate())

  // Audit §16: skip the local /api/jobs fetch when the parent already has
  // data covering our month grid. We STILL fetch iCal events + exceptions
  // (those aren't in /api/schedule/week's payload) so the guest-stay and
  // skip/reschedule chips keep working.
  const gridRange = monthGridRange(new Date(year, month, 15))
  const parentCoversMonth = rangeContains(parentRange, gridRange)

  useEffect(() => {
    if (parentCoversMonth) {
      // Use the parent's dataset; the effect below still fetches iCal +
      // exceptions independently. Clear any stale error banner.
      setMonthLoading(false)
      setMonthError(null)
      return
    }
    // Standalone path (e.g. component used elsewhere, or parent is on a
    // narrower week range): fetch the month range ourselves.
    setMonthLoading(true)
    setMonthError(null)
    get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => { setJobs(Array.isArray(d) ? d : []); setMonthLoading(false) })
      .catch(err => {
        setMonthLoading(false)
        setMonthError(err?.detail || err?.message || 'Failed to load schedule')
        console.error("[CalendarView] Failed to load jobs:", err.message || err)
      })
  }, [year, month, refreshKey, parentCoversMonth])

  useEffect(() => {
    // Guest-stay overlay is opt-in (see `showGuestStays`) — skip the fetch
    // entirely when it's off rather than fetching data nobody sees. Clear
    // any events left over from a previous "on" state.
    if (!showGuestStays) {
      setIcalEvents([])
    } else {
      get(`/api/properties/all-ical-events?start=${rangeStart}&end=${rangeEnd}`)
        .then(d => setIcalEvents(Array.isArray(d) ? d : []))
        .catch(err => console.error("[CalendarView] Failed to load iCal events:", err.message || err))
    }

    // Exceptions overlay is always fetched — it isn't in the parent's
    // payload and its failures still just log so a bad endpoint can't gray
    // out the whole schedule.
    get(`/api/recurring/exceptions?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => setExceptions(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView] Failed to load exceptions:", err.message || err))
  }, [year, month, refreshKey, showGuestStays])

  const retryMonthFetch = () => {
    setMonthLoading(true)
    setMonthError(null)
    get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => { setJobs(Array.isArray(d) ? d : []); setMonthLoading(false) })
      .catch(err => {
        setMonthLoading(false)
        setMonthError(err?.detail || err?.message || 'Failed to load schedule')
      })
  }

  // Employees roster is fetched via useEmployees above (audit §18).

  // Audit §16: when the parent covers our range, seed the local `jobs`
  // state from the parent's data. Every existing setJobs(...) call
  // (drag-drop optimistic updates, save-refetch, etc.) then continues to
  // work unchanged — the parent's next render will overwrite our local
  // state with the fresh server-of-truth data. This is the minimum-blast
  // shape that lets the two views share a fetch without rewriting the
  // 700 lines of month-grid interaction code.
  useEffect(() => {
    if (parentCoversMonth && Array.isArray(parentJobs)) {
      setJobs(parentJobs)
    }
  // parentJobs identity changes on every parent render; that's OK, the
  // shallow comparison inside React state means a real content change
  // triggers a single re-render. If this ever becomes a perf pinch,
  // memoize parentJobs at the caller.
  }, [parentCoversMonth, parentJobs])

  // Memoized so the day-cell lookup arrays keep the SAME reference across
  // renders that don't actually change jobs/filters/icalEvents/exceptions —
  // MonthDayCell is wrapped in React.memo, and a fresh array reference on
  // every render (e.g. from a dropTarget/selected state tick elsewhere)
  // would make every cell look "changed" and defeat that memoization.
  const filteredJobs = useMemo(() => jobs.filter(j => {
    // Hide cancelled jobs by default so a deleted/cancelled job comes OFF the
    // calendar instead of lingering crossed-out. Still reachable by explicitly
    // filtering for the "Cancelled" status.
    if (j.status === 'cancelled' && filters.status !== 'cancelled') return false
    if (filters.job_type && j.job_type !== filters.job_type) return false
    if (filters.status && j.status !== filters.status) return false
    if (filters.property_id && String(j.property_id) !== filters.property_id) return false
    return true
  }), [jobs, filters.status, filters.job_type, filters.property_id])

  const jobsByDay = useMemo(() => {
    const map = {}
    filteredJobs.forEach(j => {
      if (!map[j.scheduled_date]) map[j.scheduled_date] = []
      map[j.scheduled_date].push(j)
    })
    return map
  }, [filteredJobs])

  const bookingsByDay = useMemo(() => {
    const map = {}
    icalEvents.forEach(ev => {
      if (!ev.checkin_date || !ev.checkout_date) return
      const stayDays = eachDay(ev.checkin_date, ev.checkout_date)
      stayDays.forEach(d => {
        if (!map[d]) map[d] = []
        map[d].push(ev)
      })
    })
    return map
  }, [icalEvents])

  const { skipsByDay, reschedulesFromByDay, reschedulesToByDay } = useMemo(() => {
    const skipsByDay = {}
    const reschedulesFromByDay = {}
    const reschedulesToByDay = {}
    exceptions.forEach(ex => {
      if (ex.exception_type === 'skip') {
        ;(skipsByDay[ex.exception_date] ||= []).push(ex)
      } else if (ex.exception_type === 'reschedule') {
        ;(reschedulesFromByDay[ex.exception_date] ||= []).push(ex)
        if (ex.rescheduled_date) {
          ;(reschedulesToByDay[ex.rescheduled_date] ||= []).push(ex)
        }
      }
    })
    return { skipsByDay, reschedulesFromByDay, reschedulesToByDay }
  }, [exceptions])

  // Stable empty arrays so a day with no jobs/bookings/exceptions doesn't
  // get a brand-new `[]` on every render (same memoization reasoning as
  // above — MonthDayCell's props must be reference-stable to skip re-render).
  const EMPTY_ARR = useMemo(() => [], [])

  const cleanerInitials = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? initials(e.name || e.displayName || '') : ''
  }

  // Audit §16: when the parent supplies onMonthChange, prev/next also move
  // the parent's currentDate so useScheduleData refetches at the new
  // range and we don't fall off the parent-covered fast path. Without a
  // parent wired up, this reduces to the old local-only behavior.
  const _emitMonth = (y, m) => {
    if (onMonthChange) onMonthChange(new Date(y, m, 15, 12, 0, 0))
  }
  const prev = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); _emitMonth(year - 1, 11) }
    else { setMonth(m => m - 1); _emitMonth(year, month - 1) }
  }
  const next = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); _emitMonth(year + 1, 0) }
    else { setMonth(m => m + 1); _emitMonth(year, month + 1) }
  }
  const goToday = () => {
    setYear(now.getFullYear())
    setMonth(now.getMonth())
    setSelected(today)
    _emitMonth(now.getFullYear(), now.getMonth())
  }

  // Also stable (see below) so MonthDayCell's memo isn't defeated by a
  // fresh onSelectDay closure on every render.
  const onSelectDay = useCallback((date) => {
    setSelected(date)
    onDayClick?.(date)
  }, [onDayClick])

  // useCallback + functional state updates throughout this drag/touch block:
  // MonthDayCell is React.memo'd, and every cell receives the SAME handler
  // references (it binds `date`/`job` itself when calling them) — so if a
  // handler's identity changed on every dragover/touchmove tick (because it
  // read `dropTarget`/`touchDrag` state directly), ALL cells would see a
  // "changed" prop and re-render on every tick, defeating the memoization
  // this file exists to add. Reading through refs instead of the closed-over
  // state value keeps these stable for the component's whole lifetime.
  const onDragStart = useCallback((e, job) => {
    if (isMobile) return
    setDraggingJob(job)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({ jobId: job.id }))
    if (e.target) e.target.style.opacity = '0.5'
  }, [isMobile])
  const onDragEnd = useCallback((e) => {
    if (e.target) e.target.style.opacity = '1'
    setDraggingJob(null)
    setDropTarget(null)
  }, [])
  const onDragOver = useCallback((e, date) => {
    if (isMobile) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(prev => (prev !== date ? date : prev))
  }, [isMobile])
  const onDragLeave = useCallback(() => setDropTarget(null), [])

  // Shared reschedule commit for both the desktop drop handler and the touch
  // drag end. On 409 (double-booking / time-off / capacity) we surface a toast
  // with a "Reschedule anyway" retry that re-issues the PATCH with
  // allow_conflicts=true — matches the edit-modal escape hatch that already
  // exists for save-in-modal, instead of silently snapping the chip back.
  //
  // useCallback'd (with rangeStart/rangeEnd/toast deps, which only change on
  // month navigation) so onDrop/onChipTouchEnd below — themselves stable
  // across drag ticks — don't close over a stale rangeStart/rangeEnd from
  // whatever month was active when they were first created.
  const commitReschedule = useCallback(async (jobId, originalDate, targetDate, opts = {}) => {
    const { allowConflicts = false, isRetry = false, isUndo = false } = opts
    try {
      await patch(`/api/jobs/${jobId}`, {
        scheduled_date: targetDate,
        ...(allowConflicts ? { allow_conflicts: true } : {}),
      })
      if (isRetry && toast) toast.success('Rescheduled with conflict override')
      else if (isUndo && toast) toast.success('Reschedule undone')
      else if (toast) {
        // "Removes the fear of dragging things around" (Tier 1 roadmap) — every
        // successful drag/touch reschedule gets an Undo action, not just the
        // conflict-override retry path above.
        toast.success('Job rescheduled', {
          action: {
            label: 'Undo',
            onClick: () => {
              setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: originalDate } : j))
              commitRescheduleRef.current(jobId, targetDate, originalDate, { isUndo: true })
            },
          },
        })
      }
    } catch (err) {
      const status = err && (err.status || err.statusCode)
      const detail = err && (err.detail || err.message) || ''
      // Snap the local state back to the original date so the UI matches the DB.
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: originalDate } : j))
      if (status === 409 && toast) {
        toast.error(
          `Can't move: ${detail.slice(0, 160) || 'scheduling conflict'}`,
          {
            action: {
              label: 'Reschedule anyway',
              onClick: () => {
                // Optimistically push again so the chip visually jumps on retry.
                setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: targetDate } : j))
                commitRescheduleRef.current(jobId, originalDate, targetDate, { allowConflicts: true, isRetry: true })
              },
            },
          },
        )
      } else if (toast) {
        toast.error(`Reschedule failed${detail ? ': ' + detail.slice(0, 160) : ''}`)
      } else {
        console.error('[CalendarView] Reschedule failed:', err)
      }
      // Refresh the range so any partial success (or stale local state) gets
      // reconciled with the server.
      get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
        .then(d => setJobs(Array.isArray(d) ? d : []))
        .catch(() => {})
    }
  }, [rangeStart, rangeEnd, toast])
  // The "Reschedule anyway" retry above fires from inside a toast, long
  // after this specific commitReschedule closure was created — mirror into
  // a ref so that retry always calls the CURRENT version, not a stale one
  // pinned to whatever month was active when the toast was raised.
  const commitRescheduleRef = useRef(commitReschedule)
  useEffect(() => { commitRescheduleRef.current = commitReschedule }, [commitReschedule])

  const onDrop = useCallback(async (e, targetDate) => {
    if (isMobile) return
    e.preventDefault()
    setDropTarget(null)
    const job = draggingJobRef.current
    if (!job) return
    if (job.scheduled_date === targetDate) { setDraggingJob(null); return }
    const jobId = job.id
    const originalDate = job.scheduled_date
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: targetDate } : j))
    setDraggingJob(null)
    await commitRescheduleRef.current(jobId, originalDate, targetDate)
  }, [isMobile])

  // Touch drag-to-reschedule. HTML5 DnD doesn't fire on touch, so we
  // implement a small custom gesture: 200ms press-and-hold to activate,
  // then track the floating preview and the day cell under the finger via
  // document.elementFromPoint hit-testing. Persistence reuses the same
  // PATCH /api/jobs/{id} call as the desktop path.
  const [touchDrag, setTouchDrag] = useState(null) // {x, y, hoverDate} | null
  const touchStartRef = useRef(null)               // {x, y, job, timer}
  const justDraggedRef = useRef(false)             // suppress synthetic click
  // dragArmedRef/touchDragRef mirror touchDrag so onChipTouchMove/End/Cancel
  // (below) can read its current value without depending on the touchDrag
  // STATE — which changes on every finger movement and would otherwise
  // rebuild these callbacks (and re-render every memoized day cell) on
  // every touchmove tick, same reasoning as the mouse-drag handlers above.
  const dragArmedRef = useRef(false)
  const touchDragRef = useRef(null)

  const onChipTouchStart = useCallback((e, job) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    const startX = t.clientX
    const startY = t.clientY
    const timer = setTimeout(() => {
      // Press-and-hold fired — activate drag.
      dragArmedRef.current = true
      touchDragRef.current = { x: startX, y: startY, hoverDate: null }
      setTouchDrag(touchDragRef.current)
      setDraggingJob(job)
    }, 200)
    touchStartRef.current = { x: startX, y: startY, job, timer }
  }, [])

  const onChipTouchMove = useCallback((e) => {
    const start = touchStartRef.current
    if (!start || e.touches.length !== 1) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - start.x)
    const dy = Math.abs(t.clientY - start.y)
    if (!dragArmedRef.current) {
      // Drag not active yet. If finger moves > 8px before the press-and-hold
      // timer fires, it's a scroll/swipe — cancel the drag arming.
      if (dx > 8 || dy > 8) {
        clearTimeout(start.timer)
        touchStartRef.current = null
      }
      return
    }
    // Drag active — find the day cell under the finger.
    const el = typeof document !== 'undefined' ? document.elementFromPoint(t.clientX, t.clientY) : null
    const cell = el?.closest?.('[data-day-cell]')
    const date = cell?.getAttribute('data-day-cell') || null
    touchDragRef.current = { x: t.clientX, y: t.clientY, hoverDate: date }
    setTouchDrag(touchDragRef.current)
    setDropTarget(prev => (prev !== date ? date : prev))
  }, [])

  const onChipTouchEnd = useCallback(async (e) => {
    const start = touchStartRef.current
    if (start?.timer) clearTimeout(start.timer)
    touchStartRef.current = null
    const drag = touchDragRef.current
    dragArmedRef.current = false
    touchDragRef.current = null
    if (!drag || !start) {
      setTouchDrag(null)
      setDropTarget(null)
      setDraggingJob(null)
      return
    }
    // We did a real drag — suppress the synthetic click that fires after
    // touchend on touch devices (don't open the Job Edit modal).
    justDraggedRef.current = true
    const targetDate = drag.hoverDate
    const job = start.job
    setTouchDrag(null)
    setDropTarget(null)
    setDraggingJob(null)
    if (!targetDate || job.scheduled_date === targetDate) return
    // Optimistic update + persist (same shape as desktop drop). Reuses the
    // shared commitReschedule so touch drags also get the 409 "Reschedule
    // anyway" toast instead of a silent revert.
    const originalDate = job.scheduled_date
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: targetDate } : j))
    await commitRescheduleRef.current(job.id, originalDate, targetDate)
  }, [])

  const onChipTouchCancel = useCallback(() => {
    if (touchStartRef.current?.timer) clearTimeout(touchStartRef.current.timer)
    touchStartRef.current = null
    dragArmedRef.current = false
    touchDragRef.current = null
    setTouchDrag(null)
    setDropTarget(null)
    setDraggingJob(null)
  }, [])

  const startDow = firstDay.getDay()
  const totalDays = lastDay.getDate()
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= totalDays; d++) cells.push(isoDate(year, month, d))
  while (cells.length % 7 !== 0) cells.push(null)

  const selectedJobs = selected ? (jobsByDay[selected] || []) : []
  const selectedBookings = selected ? (bookingsByDay[selected] || []) : []
  const selectedSkips = selected ? (skipsByDay[selected] || []) : []
  const selectedReschedFrom = selected ? (reschedulesFromByDay[selected] || []) : []
  const selectedReschedTo = selected ? (reschedulesToByDay[selected] || []) : []

  const dayDetail = (
    <>
      <div className="px-4 py-3 border-b border-hairline flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">
            {selected
              ? new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Select a day'}
          </div>
          {selected && (
            <div className="text-xs text-ink-3 mt-0.5">
              {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''}
              {selectedBookings.length > 0 && ` · ${selectedBookings.length} Airbnb booking${selectedBookings.length !== 1 ? 's' : ''}`}
              {selectedSkips.length + selectedReschedFrom.length + selectedReschedTo.length > 0 && (
                <span className="ml-1 text-purple-600">
                  · {selectedSkips.length + selectedReschedFrom.length + selectedReschedTo.length} exception{
                    (selectedSkips.length + selectedReschedFrom.length + selectedReschedTo.length) !== 1 ? 's' : ''
                  }
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {selected && onCreateForDay && (
            <button
              onClick={() => onCreateForDay(selected)}
              className="flex items-center gap-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 px-2.5 py-1 rounded-lg transition-colors"
              aria-label="New job on this day"
            >
              <Plus className="w-3.5 h-3.5" /> New job
            </button>
          )}
          {isMobile && selected && (
            <button
              onClick={() => setSelected(null)}
              className="p-1 -mr-1 text-ink-3 hover:text-ink-2 active:text-ink-2"
              aria-label="Close day details"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin space-y-4">
        {selectedSkips.length > 0 && (
          <div>
            <p className="text-[10px] text-purple-600 font-medium mb-2 uppercase tracking-wide">Skipped Occurrences</p>
            <div className="space-y-2">
              {selectedSkips.map(ex => (
                <div key={`skip-${ex.id}`} className="bg-purple-50/50 border border-purple-200 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5">
                    <Ban className="w-3 h-3 text-purple-500 shrink-0" />
                    <span className="text-xs font-medium text-purple-700 line-through">Skipped from recurring schedule</span>
                  </div>
                  {ex.reason && <div className="text-[10px] text-ink-3 mt-1">{ex.reason}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedReschedFrom.length > 0 && (
          <div>
            <p className="text-[10px] text-purple-600 font-medium mb-2 uppercase tracking-wide">Moved Out</p>
            <div className="space-y-2">
              {selectedReschedFrom.map(ex => (
                <div key={`from-${ex.id}`} className="bg-purple-50/50 border border-purple-200 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5">
                    <ArrowRight className="w-3 h-3 text-purple-500 shrink-0" />
                    <span className="text-xs font-medium text-purple-700">Rescheduled to {ex.rescheduled_date}</span>
                  </div>
                  {ex.reason && <div className="text-[10px] text-ink-3 mt-1">{ex.reason}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedReschedTo.length > 0 && (
          <div>
            <p className="text-[10px] text-purple-600 font-medium mb-2 uppercase tracking-wide">Moved In</p>
            <div className="space-y-2">
              {selectedReschedTo.map(ex => (
                <div key={`to-${ex.id}`} className="bg-purple-50/50 border border-purple-200 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5">
                    <ArrowLeft className="w-3 h-3 text-purple-500 shrink-0" />
                    <span className="text-xs font-medium text-purple-700">Moved from {ex.exception_date}</span>
                  </div>
                  {ex.reason && <div className="text-[10px] text-ink-3 mt-1">{ex.reason}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedBookings.length > 0 && (
          <div>
            <p className="text-[10px] text-orange-600 font-medium mb-2 uppercase tracking-wide">Airbnb Bookings</p>
            <div className="space-y-2">
              {selectedBookings.map(b => (
                <div key={b.id} className="bg-orange-50 border border-orange-200 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Home className="w-3 h-3 text-orange-500 shrink-0" />
                    <span className="text-xs font-medium text-orange-700">{b.property_name}</span>
                  </div>
                  <div className="text-[10px] text-orange-600/70">{b.summary || 'Reserved'}</div>
                  <div className="text-[10px] text-ink-3 mt-1">
                    {b.checkin_date} – {b.checkout_date}
                    {b.checkout_date === selected && <span className="text-orange-600 ml-1 font-medium">checkout today</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedJobs.length > 0 && (
          <div>
            <p className="text-[10px] text-ink-3 font-medium mb-2 uppercase tracking-wide">Jobs</p>
            <div className="space-y-2">
              {selectedJobs.map(j => {
                const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                const cleanerInits = (j.cleaner_ids || []).map(cleanerInitials).filter(Boolean)
                return (
                  <div
                    key={j.id}
                    onClick={() => onJobClick?.(j)}
                    className="bg-panel hover:bg-bg active:bg-bg-2 border border-hairline rounded-lg p-3 cursor-pointer transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink truncate flex items-center gap-1">
                          {j.recurring_schedule_id && <RotateCw className="w-3 h-3 text-purple-500 shrink-0" title="Recurring" />}
                          {j.is_immediate_turnover && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-red-700 bg-red-100 border border-red-200 px-1 rounded shrink-0" title="Same-day check-out and check-in — tight cleaning window">
                              <Zap className="w-2.5 h-2.5" /> immediate
                            </span>
                          )}
                          {!j.is_immediate_turnover && j.turnover_lead_warning && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 border border-amber-200 px-1 rounded shrink-0"
                                  title={`Only ~${Math.max(0, Math.round(j.turnover_lead_hours))}h before the next guest checks in`}>
                              <Zap className="w-2.5 h-2.5" /> tight
                            </span>
                          )}
                          {j.title}
                        </div>
                        <div className="text-xs text-ink-3 mt-0.5">{j.start_time || "—"} – {j.end_time || "—"}</div>
                        {j.address && <div className="text-xs text-ink-3 truncate mt-0.5">{j.address}</div>}
                        {cleanerInits.length > 0 && (
                          <div className="flex items-center gap-1 mt-1">
                            {cleanerInits.map((ci, idx) => (
                              <span key={idx} className="text-[10px] font-semibold bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded">
                                {ci}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Phase 5: booking enrichment for STR turnovers. */}
                        {j.booking && (
                          <div className="mt-2 pt-2 border-t border-hairline space-y-0.5">
                            <div className="flex items-center gap-1 text-[10px]">
                              <ExternalLink className="w-2.5 h-2.5 text-ink-3 shrink-0" />
                              <span className="font-medium text-ink-2">{j.booking.source}</span>
                              {j.booking.summary && (
                                <span className="text-ink-3 truncate">· {j.booking.summary}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-ink-3">
                              {j.booking.guest_count && (
                                <span className="inline-flex items-center gap-0.5">
                                  <Users className="w-2.5 h-2.5" /> {j.booking.guest_count} guest{j.booking.guest_count !== 1 ? 's' : ''}
                                </span>
                              )}
                              {j.booking.checkin_date && (
                                <span>in: {j.booking.checkin_date.slice(5)}</span>
                              )}
                              {j.booking.checkout_date && (
                                <span>out: {j.booking.checkout_date.slice(5)}</span>
                              )}
                            </div>
                            {j.next_arrival && (
                              <div className="flex items-center gap-1 text-[10px] text-emerald-700 mt-1">
                                <span>→ next: {j.next_arrival.checkin_date}</span>
                                {j.next_arrival.guest_count && (
                                  <span className="text-ink-3">· {j.next_arrival.guest_count} guest{j.next_arrival.guest_count !== 1 ? 's' : ''}</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tc.pill}`}>{tc.label}</span>
                        <div className="flex gap-1">
                          {j.calendar_invite_sent && <span title="Client invited" className="text-[10px] text-blue-500">Invited</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {selected && selectedJobs.length === 0 && selectedBookings.length === 0
          && selectedSkips.length === 0 && selectedReschedFrom.length === 0 && selectedReschedTo.length === 0 && (
          <div className="text-center py-8 text-ink-3 text-sm">Nothing scheduled</div>
        )}

        {!selected && !isMobile && (
          <div className="text-center py-8 text-ink-3 text-sm">Click a day to see details</div>
        )}
      </div>
    </>
  )

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 p-2 sm:p-4">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 sm:gap-3">
            <button onClick={prev} className="p-1.5 hover:bg-bg-2 active:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-2 transition-colors" aria-label="Previous month">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h2 className="text-sm sm:text-lg font-bold text-ink w-32 sm:w-48 text-center">
              {MONTHS[month]} {year}
            </h2>
            <button onClick={next} className="p-1.5 hover:bg-bg-2 active:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-2 transition-colors" aria-label="Next month">
              <ChevronRight className="w-5 h-5" />
            </button>
            <button onClick={goToday} className="text-xs text-blue-600 hover:text-blue-700 active:text-blue-800 px-2 sm:px-3 py-1 sm:py-1.5 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 rounded-lg transition-colors font-medium">
              Today
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-3 lg:gap-4 text-xs text-ink-3">
            {/* Legend must match PROPERTY_TYPE_CONFIG (Week 1 unify): residential
                = blue, commercial = purple, turnover/STR = amber. Guest-stay
                cells stay orange because they represent iCal check-ins, not
                a job type. */}
            <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${TYPE_CONFIG.residential.dot}`} />Residential</span>
            <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${TYPE_CONFIG.commercial.dot}`} />Commercial</span>
            <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${TYPE_CONFIG.str_turnover.dot}`} />Turnover</span>
            {showGuestStays && (
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange-100 border border-orange-200" />Guest Stay</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-7 mb-1">
          {(isMobile ? DAYS_SHORT : DAYS).map((d, i) => (
            <div key={i} className="text-center text-[10px] sm:text-xs font-semibold text-ink-3 py-1.5 sm:py-2">{d}</div>
          ))}
        </div>

        {/* Audit §12: surface the month-fetch error instead of a silently
            blank grid. Retry re-hits the same endpoint. */}
        {monthError && !monthLoading && (
          <div className="mx-1 mb-1 flex items-center justify-between gap-2 text-[12px] px-3 py-1.5 rounded-md bg-red-50 border border-red-200 text-red-700">
            <span className="truncate">Couldn't load this month — <span className="text-red-600/80">{String(monthError).slice(0, 120)}</span></span>
            <button
              type="button"
              onClick={retryMonthFetch}
              className="shrink-0 text-[12px] font-semibold text-red-700 bg-red-100 hover:bg-red-200 border border-red-300 rounded-md px-2 py-0.5"
            >
              Retry
            </button>
          </div>
        )}

        <div className="relative grid grid-cols-7 flex-1 gap-px bg-bg-2 rounded-xl overflow-hidden border border-hairline">
          {/* Audit §12: skeleton overlay while the initial month fetch is in
              flight. Only for FIRST load (jobs.length === 0) — a month
              refetch after a save shouldn't blink the whole grid. */}
          {monthLoading && jobs.length === 0 && !monthError && (
            <div className="absolute inset-0 z-10 pointer-events-none bg-panel/60 backdrop-blur-[1px] p-2" data-testid="month-skeleton">
              <div className="grid grid-cols-7 gap-1 h-full">
                {Array.from({ length: 35 }).map((_, i) => (
                  <div key={i} className="rounded-md bg-bg-2/70 animate-pulse space-y-1 p-1">
                    <div className="w-4 h-4 rounded-full bg-bg-2" />
                    <div className="h-2 rounded bg-bg-2" />
                    {i % 3 === 0 && <div className="h-2 rounded bg-bg-2" />}
                  </div>
                ))}
              </div>
            </div>
          )}
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="bg-bg" />

            const isCheckout = icalEvents.some(e => e.checkout_date === date)
            const isCheckin  = icalEvents.some(e => e.checkin_date  === date)

            return (
              <MonthDayCell
                key={date}
                date={date}
                dayJobs={jobsByDay[date] || EMPTY_ARR}
                dayBookings={bookingsByDay[date] || EMPTY_ARR}
                daySkips={skipsByDay[date] || EMPTY_ARR}
                dayReschedFrom={reschedulesFromByDay[date] || EMPTY_ARR}
                dayReschedTo={reschedulesToByDay[date] || EMPTY_ARR}
                isToday={date === today}
                isSelected={date === selected}
                isDropTarget={dropTarget === date}
                isCheckin={isCheckin}
                isCheckout={isCheckout}
                isMobile={isMobile}
                maxPills={isMobile ? 2 : 3}
                typeConfig={TYPE_CONFIG}
                onSelectDay={onSelectDay}
                onDragOverDay={onDragOver}
                onDragLeaveDay={onDragLeave}
                onDropDay={onDrop}
                onChipDragStart={onDragStart}
                onChipDragEnd={onDragEnd}
                onChipTouchStart={onChipTouchStart}
                onChipTouchMove={onChipTouchMove}
                onChipTouchEnd={onChipTouchEnd}
                onChipTouchCancel={onChipTouchCancel}
                onJobClick={onJobClick}
                justDraggedRef={justDraggedRef}
              />
            )
          })}
        </div>
      </div>

      {!isMobile && (
        <div className="w-72 bg-bg border-l border-hairline flex flex-col shrink-0">
          {dayDetail}
        </div>
      )}

      {isMobile && selected && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-end"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-panel rounded-t-2xl w-full max-h-[75vh] flex flex-col shadow-glass-lg"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            <div className="w-12 h-1 bg-bg-2 rounded-full mx-auto my-2 shrink-0" />
            {dayDetail}
          </div>
        </div>
      )}

      {/* Touch-drag floating preview. Renders only while an active drag is
          in progress (after the 200ms press-and-hold has fired). The
          underlying chip stays where it is; this is the visual that
          tracks the finger. */}
      {touchDrag && draggingJob && (
        <div
          className={`fixed pointer-events-none z-50 px-2 py-1 rounded shadow-lg text-xs font-medium border ${
            (TYPE_CONFIG[draggingJob.job_type] || TYPE_CONFIG.residential).pill
          }`}
          style={{ left: touchDrag.x + 12, top: touchDrag.y + 12 }}
        >
          {draggingJob.title}
        </div>
      )}
    </div>
  )
}
