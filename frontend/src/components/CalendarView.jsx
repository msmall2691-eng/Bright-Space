import { useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Home, RotateCw, X, ArrowRight, ArrowLeft, Ban, Zap, Users, ExternalLink, Plus } from 'lucide-react'
import { get, patch } from "../api"


const TYPE_CONFIG = {
  residential:  { label: 'Residential', dot: 'bg-blue-500',   pill: 'bg-blue-50 text-blue-700 border-blue-200',   pillHover: 'hover:bg-blue-100' },
  commercial:   { label: 'Commercial',  dot: 'bg-green-500',  pill: 'bg-green-50 text-green-700 border-green-200', pillHover: 'hover:bg-green-100' },
  str_turnover: { label: 'Turnover',    dot: 'bg-orange-500', pill: 'bg-orange-50 text-orange-700 border-orange-200', pillHover: 'hover:bg-orange-100' },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

function eachDay(start, end) {
  const days = []
  const cur = new Date(start + 'T12:00:00')
  const fin = new Date(end   + 'T12:00:00')
  while (cur <= fin) {
    days.push(cur.toISOString().slice(0, 10))
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

/** Tailwind-aware breakpoint hook (md = 768px). */
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < breakpoint
  )
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return isMobile
}

export default function CalendarView({ onJobClick, onDayClick, onCreateForDay, refreshKey, filters = {} }) {
  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [jobs,       setJobs]       = useState([])
  const [icalEvents, setIcalEvents] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [selected,   setSelected]   = useState(null)
  const [employees,  setEmployees]  = useState([])

  const [draggingJob, setDraggingJob] = useState(null)
  const [dropTarget, setDropTarget]   = useState(null)

  const isMobile = useIsMobile()
  const today = now.toISOString().slice(0, 10)

  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const rangeStart = isoDate(year, month, 1)
  const rangeEnd   = isoDate(year, month, lastDay.getDate())

  useEffect(() => {
    get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => setJobs(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView] Failed to load jobs:", err.message || err))

    get(`/api/properties/all-ical-events?start=${rangeStart}&end=${rangeEnd}`)
      .then(d => setIcalEvents(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView] Failed to load iCal events:", err.message || err))

    get(`/api/recurring/exceptions?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => setExceptions(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView] Failed to load exceptions:", err.message || err))
  }, [year, month, refreshKey])

  useEffect(() => {
    get('/api/dispatch/employees')
      .then(data => setEmployees(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const filteredJobs = jobs.filter(j => {
    // Hide cancelled jobs by default so a deleted/cancelled job comes OFF the
    // calendar instead of lingering crossed-out. Still reachable by explicitly
    // filtering for the "Cancelled" status.
    if (j.status === 'cancelled' && filters.status !== 'cancelled') return false
    if (filters.job_type && j.job_type !== filters.job_type) return false
    if (filters.status && j.status !== filters.status) return false
    if (filters.property_id && String(j.property_id) !== filters.property_id) return false
    return true
  })

  const jobsByDay = {}
  filteredJobs.forEach(j => {
    if (!jobsByDay[j.scheduled_date]) jobsByDay[j.scheduled_date] = []
    jobsByDay[j.scheduled_date].push(j)
  })

  const bookingsByDay = {}
  icalEvents.forEach(ev => {
    if (!ev.checkin_date || !ev.checkout_date) return
    const stayDays = eachDay(ev.checkin_date, ev.checkout_date)
    stayDays.forEach(d => {
      if (!bookingsByDay[d]) bookingsByDay[d] = []
      bookingsByDay[d].push(ev)
    })
  })

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

  const cleanerInitials = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? initials(e.name || e.displayName || '') : ''
  }

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }
  const goToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth()); setSelected(today) }

  const onDragStart = (e, job) => {
    if (isMobile) return
    setDraggingJob(job)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({ jobId: job.id }))
    if (e.target) e.target.style.opacity = '0.5'
  }
  const onDragEnd = (e) => {
    if (e.target) e.target.style.opacity = '1'
    setDraggingJob(null)
    setDropTarget(null)
  }
  const onDragOver = (e, date) => {
    if (isMobile) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== date) setDropTarget(date)
  }
  const onDragLeave = () => setDropTarget(null)
  const onDrop = async (e, targetDate) => {
    if (isMobile) return
    e.preventDefault()
    setDropTarget(null)
    if (!draggingJob) return
    if (draggingJob.scheduled_date === targetDate) { setDraggingJob(null); return }
    const jobId = draggingJob.id
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: targetDate } : j))
    setDraggingJob(null)
    try {
      await patch(`/api/jobs/${jobId}`, { scheduled_date: targetDate })
    } catch (err) {
      console.error('[CalendarView] Reschedule failed:', err)
      get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
        .then(d => setJobs(Array.isArray(d) ? d : []))
        .catch(() => {})
    }
  }

  // Touch drag-to-reschedule. HTML5 DnD doesn't fire on touch, so we
  // implement a small custom gesture: 200ms press-and-hold to activate,
  // then track the floating preview and the day cell under the finger via
  // document.elementFromPoint hit-testing. Persistence reuses the same
  // PATCH /api/jobs/{id} call as the desktop path.
  const [touchDrag, setTouchDrag] = useState(null) // {x, y, hoverDate} | null
  const touchStartRef = useRef(null)               // {x, y, job, timer}
  const justDraggedRef = useRef(false)             // suppress synthetic click

  const onChipTouchStart = (e, job) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    const startX = t.clientX
    const startY = t.clientY
    const timer = setTimeout(() => {
      // Press-and-hold fired — activate drag.
      setTouchDrag({ x: startX, y: startY, hoverDate: null })
      setDraggingJob(job)
    }, 200)
    touchStartRef.current = { x: startX, y: startY, job, timer }
  }

  const onChipTouchMove = (e) => {
    const start = touchStartRef.current
    if (!start || e.touches.length !== 1) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - start.x)
    const dy = Math.abs(t.clientY - start.y)
    if (touchDrag === null) {
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
    setTouchDrag({ x: t.clientX, y: t.clientY, hoverDate: date })
    if (dropTarget !== date) setDropTarget(date)
  }

  const onChipTouchEnd = async (e) => {
    const start = touchStartRef.current
    if (start?.timer) clearTimeout(start.timer)
    touchStartRef.current = null
    if (!touchDrag || !start) {
      setTouchDrag(null)
      setDropTarget(null)
      setDraggingJob(null)
      return
    }
    // We did a real drag — suppress the synthetic click that fires after
    // touchend on touch devices (don't open the Job Edit modal).
    justDraggedRef.current = true
    const targetDate = touchDrag.hoverDate
    const job = start.job
    setTouchDrag(null)
    setDropTarget(null)
    setDraggingJob(null)
    if (!targetDate || job.scheduled_date === targetDate) return
    // Optimistic update + persist (same shape as desktop drop).
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: targetDate } : j))
    try {
      await patch(`/api/jobs/${job.id}`, { scheduled_date: targetDate })
    } catch (err) {
      console.error('[CalendarView] Touch reschedule failed:', err)
      get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
        .then(d => setJobs(Array.isArray(d) ? d : []))
        .catch(() => {})
    }
  }

  const onChipTouchCancel = () => {
    if (touchStartRef.current?.timer) clearTimeout(touchStartRef.current.timer)
    touchStartRef.current = null
    setTouchDrag(null)
    setDropTarget(null)
    setDraggingJob(null)
  }

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
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" />Residential</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" />Commercial</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-500" />Turnover</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange-100 border border-orange-200" />Guest Stay</span>
          </div>
        </div>

        <div className="grid grid-cols-7 mb-1">
          {(isMobile ? DAYS_SHORT : DAYS).map((d, i) => (
            <div key={i} className="text-center text-[10px] sm:text-xs font-semibold text-ink-3 py-1.5 sm:py-2">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 flex-1 gap-px bg-bg-2 rounded-xl overflow-hidden border border-hairline">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="bg-bg" />

            const dayJobs = jobsByDay[date] || []
            const dayBookings = bookingsByDay[date] || []
            const daySkips = skipsByDay[date] || []
            const dayReschedFrom = reschedulesFromByDay[date] || []
            const dayReschedTo = reschedulesToByDay[date] || []
            const isToday = date === today
            const isSelected = date === selected
            const isCheckout = icalEvents.some(e => e.checkout_date === date)
            const isCheckin  = icalEvents.some(e => e.checkin_date  === date)
            const isDropTarget = dropTarget === date
            const maxPills = isMobile ? 2 : 3

            return (
              <div
                key={date}
                data-day-cell={date}
                onClick={() => { setSelected(date); onDayClick?.(date) }}
                onDragOver={e => onDragOver(e, date)}
                onDragLeave={onDragLeave}
                onDrop={e => onDrop(e, date)}
                className={`relative p-1 sm:p-1.5 min-h-[64px] sm:min-h-[80px] cursor-pointer transition-colors ${
                  isDropTarget ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' :
                  isSelected ? 'bg-blue-50/60' :
                  dayBookings.length > 0 ? 'bg-orange-50/50 hover:bg-orange-50' :
                  'bg-panel hover:bg-bg'
                }`}
              >
                <div className={`text-[10px] sm:text-xs font-semibold w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full mb-0.5 sm:mb-1 ${
                  isToday ? 'bg-blue-500 text-white' :
                  isSelected ? 'text-blue-600' :
                  'text-ink-2'
                }`}>
                  {parseInt(date.slice(8))}
                </div>

                {dayBookings.length > 0 && !isMobile && (
                  <div className="text-[10px] text-orange-600/70 mb-0.5 truncate leading-tight">
                    {isCheckin && '> '}
                    {dayBookings[0].property_name || 'Guest'}
                    {isCheckout && ' (out)'}
                  </div>
                )}

                {daySkips.length > 0 && (
                  <div
                    className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/60 text-purple-700 border-purple-200 line-through truncate leading-tight"
                    title={`${daySkips.length} occurrence(s) skipped on this date${daySkips[0].reason ? ': ' + daySkips[0].reason : ''}`}
                  >
                    <Ban className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">skipped</span>
                  </div>
                )}

                {dayReschedFrom.length > 0 && (
                  <div
                    className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/40 text-purple-600 border-purple-200 italic truncate leading-tight"
                    title={`Moved to ${dayReschedFrom[0].rescheduled_date}`}
                  >
                    <ArrowRight className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">→ {dayReschedFrom[0].rescheduled_date?.slice(5)}</span>
                  </div>
                )}

                {dayReschedTo.length > 0 && (
                  <div
                    className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50 text-purple-700 border-purple-300 truncate leading-tight"
                    title={`Moved from ${dayReschedTo[0].exception_date}`}
                  >
                    <ArrowLeft className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">moved</span>
                  </div>
                )}

                <div className="space-y-0.5">
                  {dayJobs.slice(0, maxPills).map(j => {
                    const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                    const cleanerInits = (j.cleaner_ids || []).map(cleanerInitials).filter(Boolean)
                    const isDuplicate = j.job_type === 'str_turnover' && j.property_id &&
                      dayJobs.filter(dj => dj.job_type === 'str_turnover' && dj.property_id === j.property_id).length > 1
                    const isCancelled = j.status === 'cancelled'
                    return (
                      <div
                        key={j.id}
                        draggable={!isMobile}
                        onDragStart={e => onDragStart(e, j)}
                        onDragEnd={onDragEnd}
                        onTouchStart={e => onChipTouchStart(e, j)}
                        onTouchMove={onChipTouchMove}
                        onTouchEnd={onChipTouchEnd}
                        onTouchCancel={onChipTouchCancel}
                        style={{ touchAction: 'none' }}
                        onClick={e => {
                          // Suppress the synthetic click that fires after a touch-drag.
                          if (justDraggedRef.current) {
                            justDraggedRef.current = false
                            e.stopPropagation()
                            return
                          }
                          e.stopPropagation()
                          onJobClick?.(j)
                        }}
                        className={`flex items-center gap-0.5 text-[9px] sm:text-[10px] px-0.5 sm:px-1.5 py-0.5 rounded border truncate leading-tight cursor-grab active:cursor-grabbing ${
                          isCancelled ? 'bg-bg-2 text-ink-3 border-hairline line-through' :
                          isDuplicate ? 'bg-red-50 text-red-700 border-red-300 ring-1 ring-red-200' :
                          `${tc.pill} ${tc.pillHover}`
                        }`}
                        title={`${j.title}${j.recurring_schedule_id ? ' (recurring)' : ''} — press-and-hold to reschedule`}
                      >
                        {isDuplicate && <span className="shrink-0 mr-0.5 text-red-500" title="Duplicate turnover detected">⚠</span>}
                        {j.is_immediate_turnover && (
                          <Zap className="w-2.5 h-2.5 shrink-0 text-red-600" title="Immediate turnover — same-day check-in" />
                        )}
                        {j.recurring_schedule_id && <RotateCw className="w-2.5 h-2.5 shrink-0 opacity-60" />}
                        <span className="truncate">{!isMobile && j.start_time ? `${j.start_time} ` : ''}{j.title}</span>
                        {!isMobile && cleanerInits.length > 0 && (
                          <span className="ml-auto shrink-0 text-[9px] font-semibold opacity-60">{cleanerInits.join(',')}</span>
                        )}
                      </div>
                    )
                  })}
                  {dayJobs.length > maxPills && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setSelected(date); onDayClick?.(date) }}
                      className="text-[9px] sm:text-[10px] font-medium text-blue-600 hover:text-blue-700 hover:underline px-0.5 sm:px-1 py-0.5 w-full text-left"
                    >
                      +{dayJobs.length - maxPills} more
                    </button>
                  )}
                </div>
              </div>
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
