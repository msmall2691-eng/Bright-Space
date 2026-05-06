import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Home, RotateCw, X, ArrowRight, ArrowLeft, Ban } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCenter,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
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

/** Build a multi-line title attribute for a job chip — surfaces full info on hover. */
function jobTooltip(j, cleanerInits) {
  const lines = [
    j.title,
    j.start_time ? `${j.start_time}${j.end_time ? '–' + j.end_time : ''}` : null,
    j.address,
    cleanerInits.length > 0 ? `Cleaners: ${cleanerInits.join(', ')}` : null,
    j.recurring_schedule_id ? 'Recurring' : null,
    j.status === 'cancelled' ? 'CANCELLED' : null,
    'Drag to reschedule',
  ].filter(Boolean)
  return lines.join('\n')
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

/** A single day-cell — drop target for @dnd-kit. */
function DayCell({ date, isToday, isSelected, isDropTarget, dayBookings, isCheckin, isCheckout, daySkips, dayReschedFrom, dayReschedTo, dayJobs, isMobile, cleanerInitials, onSelect, onJobClick }) {
  const { setNodeRef } = useDroppable({ id: date })
  return (
    <div
      ref={setNodeRef}
      onClick={onSelect}
      className={`relative p-1 sm:p-1.5 min-h-[64px] sm:min-h-[80px] max-h-[180px] cursor-pointer transition-colors flex flex-col ${
        isDropTarget ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' :
        isSelected ? 'bg-blue-50/60' :
        dayBookings.length > 0 ? 'bg-orange-50/50 hover:bg-orange-50' :
        'bg-white hover:bg-gray-50'
      }`}
    >
      <div className={`text-[10px] sm:text-xs font-semibold w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full mb-0.5 sm:mb-1 shrink-0 ${
        isToday ? 'bg-blue-500 text-white' :
        isSelected ? 'text-blue-600' :
        'text-gray-600'
      }`}>
        {parseInt(date.slice(8))}
      </div>

      {dayBookings.length > 0 && !isMobile && (
        <div className="text-[10px] text-orange-600/70 mb-0.5 truncate leading-tight shrink-0">
          {isCheckin && '> '}
          {dayBookings[0].property_name || 'Guest'}
          {isCheckout && ' (out)'}
        </div>
      )}

      {daySkips.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/60 text-purple-700 border-purple-200 line-through truncate leading-tight shrink-0"
          title={`${daySkips.length} occurrence(s) skipped on this date${daySkips[0].reason ? ': ' + daySkips[0].reason : ''}`}
        >
          <Ban className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">skipped</span>
        </div>
      )}

      {dayReschedFrom.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50/40 text-purple-600 border-purple-200 italic truncate leading-tight shrink-0"
          title={`Moved to ${dayReschedFrom[0].rescheduled_date}`}
        >
          <ArrowRight className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">→ {dayReschedFrom[0].rescheduled_date?.slice(5)}</span>
        </div>
      )}

      {dayReschedTo.length > 0 && (
        <div
          className="flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 mb-0.5 rounded border bg-purple-50 text-purple-700 border-purple-300 truncate leading-tight shrink-0"
          title={`Moved from ${dayReschedTo[0].exception_date}`}
        >
          <ArrowLeft className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">moved</span>
        </div>
      )}

      {/* Phase 3.5: ALL chips render. Inner container scrolls so a busy
          day with 8+ jobs doesn't push the calendar's other rows down. */}
      <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto scrollbar-thin">
        {dayJobs.map(j => {
          const cleanerInits = (j.cleaner_ids || []).map(cleanerInitials).filter(Boolean)
          const isDuplicate = j.job_type === 'str_turnover' && j.property_id &&
            dayJobs.filter(dj => dj.job_type === 'str_turnover' && dj.property_id === j.property_id).length > 1
          return (
            <DraggableChip
              key={j.id}
              job={j}
              cleanerInits={cleanerInits}
              isDuplicate={isDuplicate}
              isMobile={isMobile}
              onClick={(e) => { e.stopPropagation(); onJobClick?.(j) }}
            />
          )
        })}
      </div>
    </div>
  )
}

/** A single job chip — drag source for @dnd-kit. */
function DraggableChip({ job, cleanerInits, isDuplicate, isMobile, onClick }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(job.id),
    data: { jobId: job.id },
  })
  const tc = TYPE_CONFIG[job.job_type] || TYPE_CONFIG.residential
  const isCancelled = job.status === 'cancelled'
  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    touchAction: 'manipulation',
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={`flex items-center gap-0.5 text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 rounded border truncate leading-tight cursor-grab active:cursor-grabbing select-none ${
        isCancelled ? 'bg-zinc-100 text-zinc-400 border-zinc-200 line-through' :
        isDuplicate ? 'bg-red-50 text-red-700 border-red-300 ring-1 ring-red-200' :
        `${tc.pill} ${tc.pillHover}`
      }`}
      title={jobTooltip(job, cleanerInits)}
    >
      {isDuplicate && <span className="shrink-0 mr-0.5 text-red-500" title="Duplicate turnover detected">⚠</span>}
      {job.recurring_schedule_id && <RotateCw className="w-2.5 h-2.5 shrink-0 opacity-60" />}
      <span className="truncate">{!isMobile && job.start_time ? `${job.start_time} ` : ''}{job.title}</span>
      {!isMobile && cleanerInits.length > 0 && (
        <span className="ml-auto shrink-0 text-[9px] font-semibold opacity-60">{cleanerInits.join(',')}</span>
      )}
    </div>
  )
}

export default function CalendarView({ onJobClick, onDayClick, refreshKey, filters = {} }) {
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

  // @dnd-kit sensors. PointerSensor covers mouse + most touch with a small
  // 5px drag threshold so a click doesn't accidentally drag. TouchSensor adds
  // a 200ms press-and-hold so tap-to-select on phones doesn't initiate a drag.
  // KeyboardSensor is for accessibility (Tab + Space picks up a chip).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  )

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

  // @dnd-kit handlers — single onDragStart/onDragEnd at the DndContext level,
  // works for mouse, touch, and keyboard. Drop targets register via useDroppable
  // (each day cell), draggables via useDraggable (each job chip).
  const handleDragStart = ({ active }) => {
    const job = filteredJobs.find(j => String(j.id) === String(active.id))
    if (job) setDraggingJob(job)
  }
  const handleDragOver = ({ over }) => {
    setDropTarget(over ? over.id : null)
  }
  const handleDragEnd = async ({ active, over }) => {
    setDropTarget(null)
    const job = draggingJob
    setDraggingJob(null)
    if (!job || !over) return
    const targetDate = String(over.id)
    if (job.scheduled_date === targetDate) return
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: targetDate } : j))
    try {
      await patch(`/api/jobs/${job.id}`, { scheduled_date: targetDate })
    } catch (err) {
      console.error('[CalendarView] Reschedule failed:', err)
      get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
        .then(d => setJobs(Array.isArray(d) ? d : []))
        .catch(() => {})
    }
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
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            {selected
              ? new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Select a day'}
          </div>
          {selected && (
            <div className="text-xs text-gray-500 mt-0.5">
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
        {isMobile && selected && (
          <button
            onClick={() => setSelected(null)}
            className="p-1 -mr-1 text-gray-400 hover:text-gray-600 active:text-gray-800"
            aria-label="Close day details"
          >
            <X className="w-5 h-5" />
          </button>
        )}
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
                  {ex.reason && <div className="text-[10px] text-gray-500 mt-1">{ex.reason}</div>}
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
                  {ex.reason && <div className="text-[10px] text-gray-500 mt-1">{ex.reason}</div>}
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
                  {ex.reason && <div className="text-[10px] text-gray-500 mt-1">{ex.reason}</div>}
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
                  <div className="text-[10px] text-gray-500 mt-1">
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
            <p className="text-[10px] text-gray-400 font-medium mb-2 uppercase tracking-wide">Jobs</p>
            <div className="space-y-2">
              {selectedJobs.map(j => {
                const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                const cleanerInits = (j.cleaner_ids || []).map(cleanerInitials).filter(Boolean)
                return (
                  <div
                    key={j.id}
                    onClick={() => onJobClick?.(j)}
                    className="bg-white hover:bg-gray-50 active:bg-gray-100 border border-gray-200 rounded-lg p-3 cursor-pointer transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-1">
                          {j.recurring_schedule_id && <RotateCw className="w-3 h-3 text-purple-500 shrink-0" title="Recurring" />}
                          {j.title}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{j.start_time || "—"} – {j.end_time || "—"}</div>
                        {j.address && <div className="text-xs text-gray-400 truncate mt-0.5">{j.address}</div>}
                        {cleanerInits.length > 0 && (
                          <div className="flex items-center gap-1 mt-1">
                            {cleanerInits.map((ci, idx) => (
                              <span key={idx} className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                {ci}
                              </span>
                            ))}
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
          <div className="text-center py-8 text-gray-400 text-sm">Nothing scheduled</div>
        )}

        {!selected && !isMobile && (
          <div className="text-center py-8 text-gray-400 text-sm">Click a day to see details</div>
        )}
      </div>
    </>
  )

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 p-2 sm:p-4">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 sm:gap-3">
            <button onClick={prev} className="p-1.5 hover:bg-gray-100 active:bg-gray-200 rounded-lg text-gray-500 hover:text-gray-700 transition-colors" aria-label="Previous month">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h2 className="text-sm sm:text-lg font-bold text-gray-900 w-32 sm:w-48 text-center">
              {MONTHS[month]} {year}
            </h2>
            <button onClick={next} className="p-1.5 hover:bg-gray-100 active:bg-gray-200 rounded-lg text-gray-500 hover:text-gray-700 transition-colors" aria-label="Next month">
              <ChevronRight className="w-5 h-5" />
            </button>
            <button onClick={goToday} className="text-xs text-blue-600 hover:text-blue-700 active:text-blue-800 px-2 sm:px-3 py-1 sm:py-1.5 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 rounded-lg transition-colors font-medium">
              Today
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-3 lg:gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" />Residential</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" />Commercial</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-500" />Turnover</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange-100 border border-orange-200" />Guest Stay</span>
          </div>
        </div>

        <div className="grid grid-cols-7 mb-1">
          {(isMobile ? DAYS_SHORT : DAYS).map((d, i) => (
            <div key={i} className="text-center text-[10px] sm:text-xs font-semibold text-gray-500 py-1.5 sm:py-2">{d}</div>
          ))}
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="grid grid-cols-7 flex-1 gap-px bg-gray-200 rounded-xl overflow-hidden border border-gray-200">
            {cells.map((date, i) => {
              if (!date) return <div key={i} className="bg-gray-50" />
              const dayJobs = jobsByDay[date] || []
              return (
                <DayCell
                  key={date}
                  date={date}
                  isToday={date === today}
                  isSelected={date === selected}
                  isDropTarget={dropTarget === date}
                  dayBookings={bookingsByDay[date] || []}
                  isCheckin={icalEvents.some(e => e.checkin_date === date)}
                  isCheckout={icalEvents.some(e => e.checkout_date === date)}
                  daySkips={skipsByDay[date] || []}
                  dayReschedFrom={reschedulesFromByDay[date] || []}
                  dayReschedTo={reschedulesToByDay[date] || []}
                  dayJobs={dayJobs}
                  isMobile={isMobile}
                  cleanerInitials={cleanerInitials}
                  onSelect={() => { setSelected(date); onDayClick?.(date) }}
                  onJobClick={onJobClick}
                />
              )
            })}
          </div>

          {/* Floating preview while a chip is being dragged. */}
          <DragOverlay>
            {draggingJob && (
              <div className={`text-[10px] px-1.5 py-0.5 rounded border shadow-lg ${
                (TYPE_CONFIG[draggingJob.job_type] || TYPE_CONFIG.residential).pill
              }`}>
                {draggingJob.title}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {!isMobile && (
        <div className="w-72 bg-gray-50 border-l border-gray-200 flex flex-col shrink-0">
          {dayDetail}
        </div>
      )}

      {isMobile && selected && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-end"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white rounded-t-2xl w-full max-h-[75vh] flex flex-col shadow-glass-lg"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto my-2 shrink-0" />
            {dayDetail}
          </div>
        </div>
      )}
    </div>
  )
}
