import { useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Calendar, Home, Users, Briefcase, RotateCw } from 'lucide-react'
import { get, patch } from "../api"


const TYPE_CONFIG = {
  residential:  { label: 'Residential', dot: 'bg-blue-500',   pill: 'bg-blue-50 text-blue-700 border-blue-200',   pillHover: 'hover:bg-blue-100' },
  commercial:   { label: 'Commercial',  dot: 'bg-green-500',  pill: 'bg-green-50 text-green-700 border-green-200', pillHover: 'hover:bg-green-100' },
  str_turnover: { label: 'Turnover',    dot: 'bg-orange-500', pill: 'bg-orange-50 text-orange-700 border-orange-200', pillHover: 'hover:bg-orange-100' },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

function eachDay(start, end) {
  // Returns all YYYY-MM-DD strings from start to end inclusive
  const days = []
  const cur = new Date(start + 'T12:00:00')
  const fin = new Date(end   + 'T12:00:00')
  while (cur <= fin) {
    days.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

/** Get cleaner initials from a name string, e.g. "Megan Small" -> "MS" */
function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return parts[0].slice(0, 2).toUpperCase()
}

export default function CalendarView({ onJobClick, onDayClick, refreshKey, filters = {} }) {
  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())    // 0-indexed
  const [jobs,       setJobs]       = useState([])
  const [icalEvents, setIcalEvents] = useState([])
  const [selected,   setSelected]   = useState(null)    // YYYY-MM-DD
  const [employees,  setEmployees]  = useState([])

  // Drag-and-drop state
  const [draggingJob, setDraggingJob] = useState(null)
  const [dropTarget, setDropTarget]   = useState(null)

  const today = now.toISOString().slice(0, 10)

  // Date range for current month view
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
  }, [year, month, refreshKey])

  // Load employees for cleaner initials
  useEffect(() => {
    get('/api/dispatch/employees')
      .then(data => setEmployees(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // Apply filters to jobs
  const filteredJobs = jobs.filter(j => {
    if (filters.job_type && j.job_type !== filters.job_type) return false
    if (filters.status && j.status !== filters.status) return false
    if (filters.property_id && String(j.property_id) !== filters.property_id) return false
    return true
  })

  // Build day Ã¢ÂÂ jobs map
  const jobsByDay = {}
  filteredJobs.forEach(j => {
    if (!jobsByDay[j.scheduled_date]) jobsByDay[j.scheduled_date] = []
    jobsByDay[j.scheduled_date].push(j)
  })

  // Build day Ã¢ÂÂ booking blocks map (for Airbnb stays)
  const bookingsByDay = {}
  icalEvents.forEach(ev => {
    if (!ev.checkin_date || !ev.checkout_date) return
    // Guest stay spans from checkin to day BEFORE checkout (checkout day = cleaning day)
    const stayDays = eachDay(ev.checkin_date, ev.checkout_date)
    stayDays.forEach(d => {
      if (!bookingsByDay[d]) bookingsByDay[d] = []
      bookingsByDay[d].push(ev)
    })
  })

  /** Get initials for a cleaner ID */
  const cleanerInitials = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? initials(e.name || e.displayName || '') : ''
  }

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }
  const goToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth()); setSelected(today) }

  // Drag-and-drop handlers
  const onDragStart = (e, job) => {
    setDraggingJob(job)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({ jobId: job.id }))
    // Make drag image slightly transparent
    if (e.target) e.target.style.opacity = '0.5'
  }
  const onDragEnd = (e) => {
    if (e.target) e.target.style.opacity = '1'
    setDraggingJob(null)
    setDropTarget(null)
  }
  const onDragOver = (e, date) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== date) setDropTarget(date)
  }
  const onDragLeave = () => {
    setDropTarget(null)
  }
  const onDrop = async (e, targetDate) => {
    e.preventDefault()
    setDropTarget(null)
    if (!draggingJob) return
    if (draggingJob.scheduled_date === targetDate) { setDraggingJob(null); return }
    // Optimistically update local state
    const jobId = draggingJob.id
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, scheduled_date: targetDate } : j))
    setDraggingJob(null)
    // Persist to backend (BrightBase is source of truth Ã¢ÂÂ this also syncs to GCal)
    try {
      await patch(`/api/jobs/${jobId}`, { scheduled_date: targetDate })
    } catch (err) {
      console.error('[CalendarView] Reschedule failed:', err)
      // Revert on failure by re-fetching
      get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
        .then(d => setJobs(Array.isArray(d) ? d : []))
        .catch(() => {})
    }
  }

  // Build calendar grid
  const startDow = firstDay.getDay()  // 0=Sun
  const totalDays = lastDay.getDate()
  const cells = []

  // Leading empty cells
  for (let i = 0; i < startDow; i++) cells.push(null)
  // Day cells
  for (let d = 1; d <= totalDays; d++) cells.push(isoDate(year, month, d))
  // Trailing empty cells to fill 6 rows
  while (cells.length % 7 !== 0) cells.push(null)

  const selectedJobs = selected ? (jobsByDay[selected] || []) : []
  const selectedBookings = selected ? (bookingsByDay[selected] || []) : []

  return (
    <div className="flex h-full min-h-0">
      {/* Calendar grid */}
      <div className="flex-1 flex flex-col min-w-0 p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={prev} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700 transition-colors">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-bold text-gray-900 w-48 text-center">
              {MONTHS[month]} {year}
            </h2>
            <button onClick={next} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700 transition-colors">
              <ChevronRight className="w-5 h-5" />
            </button>
            <button onClick={goToday} className="text-xs text-blue-600 hover:text-blue-700 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors font-medium">
              Today
            </button>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" />Residential</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" />Commercial</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-500" />STR Turnover</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange-100 border border-orange-200" />Guest Stay</span>
          </div>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAYS.map(d => (
            <div key={d} className="text-center text-xs font-semibold text-gray-500 py-2">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7 flex-1 gap-px bg-gray-200 rounded-xl overflow-hidden border border-gray-200">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="bg-gray-50" />

            const dayJobs = jobsByDay[date] || []
            const dayBookings = bookingsByDay[date] || []
            const isToday = date === today
            const isSelected = date === selected
            const isCheckout = icalEvents.some(e => e.checkout_date === date)
            const isCheckin  = icalEvents.some(e => e.checkin_date  === date)

            const isDropTarget = dropTarget === date

            return (
              <div
                key={date}
                onClick={() => { setSelected(date); onDayClick?.(date) }}
                onDragOver={e => onDragOver(e, date)}
                onDragLeave={onDragLeave}
                onDrop={e => onDrop(e, date)}
                className={`relative p-1.5 min-h-[80px] cursor-pointer transition-colors ${
                  isDropTarget ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' :
                  isSelected ? 'bg-blue-50/60' :
                  dayBookings.length > 0 ? 'bg-orange-50/50 hover:bg-orange-50' :
                  'bg-white hover:bg-gray-50'
                }`}
              >
                {/* Date number */}
                <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full mb-1 ${
                  isToday ? 'bg-blue-500 text-white' :
                  isSelected ? 'text-blue-600' :
                  'text-gray-600'
                }`}>
                  {parseInt(date.slice(8))}
                </div>

                {/* Guest stay indicator */}
                {dayBookings.length > 0 && (
                  <div className="text-[10px] text-orange-600/70 mb-0.5 truncate leading-tight">
                    {isCheckin && '> '}
                    {dayBookings[0].property_name || 'Guest'}
                    {isCheckout && ' (out)'}
                  </div>
                )}

                {/* Job pills */}
                <div className="space-y-0.5">
                  {dayJobs.slice(0, 3).map(j => {
                    const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                    const cleanerInits = (j.cleaner_ids || []).map(cleanerInitials).filter(Boolean)
                    // Duplicate detection: flag if multiple turnover jobs for same property on same day
                    const isDuplicate = j.job_type === 'str_turnover' && j.property_id &&
                      dayJobs.filter(dj => dj.job_type === 'str_turnover' && dj.property_id === j.property_id).length > 1
                    return (
                      <div
                        key={j.id}
                        draggable
                        onDragStart={e => onDragStart(e, j)}
                        onDragEnd={onDragEnd}
                        onClick={e => { e.stopPropagation(); onJobClick?.(j) }}
                        className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border truncate leading-tight cursor-grab active:cursor-grabbing ${
                          isDuplicate ? 'bg-red-50 text-red-700 border-red-300 ring-1 ring-red-200' : `${tc.pill} ${tc.pillHover}`
                        }`}
                        title={`${j.title}${j.recurring_schedule_id ? ' (recurring)' : ''} Ã¢ÂÂ drag to reschedule`}
                      >
                        {isDuplicate && <span className="shrink-0 mr-0.5 text-red-500" title="Duplicate turnover detected">â </span>}
                        {j.recurring_schedule_id && <RotateCw className="w-2.5 h-2.5 shrink-0 opacity-60" />}
                        <span className="truncate">{j.start_time ? `${j.start_time} ` : ''}{j.title}</span>
                        {cleanerInits.length > 0 && (
                          <span className="ml-auto shrink-0 text-[9px] font-semibold opacity-60">{cleanerInits.join(',')}</span>
                        )}
                      </div>
                    )
                  })}
                  {dayJobs.length > 3 && (
                    <div className="text-[10px] text-gray-400 px-1">+{dayJobs.length - 3} more</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Day detail panel */}
      <div className="w-72 bg-gray-50 border-l border-gray-200 flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="text-sm font-semibold text-gray-900">
            {selected
              ? new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Select a day'}
          </div>
          {selected && (
            <div className="text-xs text-gray-500 mt-0.5">
              {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''}
              {selectedBookings.length > 0 && ` ÃÂ· ${selectedBookings.length} Airbnb booking${selectedBookings.length !== 1 ? 's' : ''}`}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin space-y-4">
          {/* Airbnb bookings */}
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
                      {b.checkin_date} Ã¢ÂÂ {b.checkout_date}
                      {b.checkout_date === selected && <span className="text-orange-600 ml-1 font-medium">checkout today</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Jobs */}
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
                      className="bg-white hover:bg-gray-50 border border-gray-200 rounded-lg p-3 cursor-pointer transition-colors"
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

          {selected && selectedJobs.length === 0 && selectedBookings.length === 0 && (
            <div className="text-center py-8 text-gray-400 text-sm">Nothing scheduled</div>
          )}

          {!selected && (
            <div className="text-center py-8 text-gray-400 text-sm">Click a day to see details</div>
          )}
        </div>
      </div>
    </div>
  )
}
