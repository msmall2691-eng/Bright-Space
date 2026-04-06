import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Calendar, Home, Users, Briefcase } from 'lucide-react'
import { get } from "../api"


const TYPE_CONFIG = {
  residential:  { label: 'Residential', dot: 'bg-blue-400',   pill: 'bg-blue-500/30 text-blue-300 border-blue-500/40' },
  commercial:   { label: 'Commercial',  dot: 'bg-green-400',  pill: 'bg-green-500/30 text-green-300 border-green-500/40' },
  str_turnover: { label: 'Turnover',    dot: 'bg-orange-400', pill: 'bg-orange-500/30 text-orange-300 border-orange-500/40' },
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

export default function CalendarView({ onJobClick, onDayClick, refreshKey }) {
  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())    // 0-indexed
  const [jobs,       setJobs]       = useState([])
  const [icalEvents, setIcalEvents] = useState([])
  const [selected,   setSelected]   = useState(null)    // YYYY-MM-DD

  const today = now.toISOString().slice(0, 10)

  // Date range for current month view
  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const rangeStart = isoDate(year, month, 1)
  const rangeEnd   = isoDate(year, month, lastDay.getDate())

  useEffect(() => {
    get(`/api/jobs?date_from=${rangeStart}&date_to=${rangeEnd}`)
      .then(d => setJobs(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView]", err))

    get(`/api/properties/all-ical-events?start=${rangeStart}&end=${rangeEnd}`)
      .then(d => setIcalEvents(Array.isArray(d) ? d : []))
      .catch(err => console.error("[CalendarView]", err))
  }, [year, month, refreshKey])

  // Build day → jobs map
  const jobsByDay = {}
  jobs.forEach(j => {
    if (!jobsByDay[j.scheduled_date]) jobsByDay[j.scheduled_date] = []
    jobsByDay[j.scheduled_date].push(j)
  })

  // Build day → booking blocks map (for Airbnb stays)
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

  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }
  const goToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth()); setSelected(today) }

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
            <button onClick={prev} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-bold text-white w-48 text-center">
              {MONTHS[month]} {year}
            </h2>
            <button onClick={next} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors">
              <ChevronRight className="w-5 h-5" />
            </button>
            <button onClick={goToday} className="text-xs text-sky-400 hover:text-sky-300 px-3 py-1.5 bg-sky-600/10 hover:bg-sky-600/20 rounded-lg transition-colors">
              Today
            </button>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-400" />Residential</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-400" />Commercial</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400" />STR Turnover</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange-900/60 border border-orange-800" />Guest Stay</span>
          </div>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAYS.map(d => (
            <div key={d} className="text-center text-xs font-medium text-gray-500 py-1">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7 flex-1 gap-px bg-gray-800 rounded-xl overflow-hidden border border-gray-800">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="bg-gray-950/60" />

            const dayJobs = jobsByDay[date] || []
            const dayBookings = bookingsByDay[date] || []
            const isToday = date === today
            const isSelected = date === selected
            const isCheckout = icalEvents.some(e => e.checkout_date === date)
            const isCheckin  = icalEvents.some(e => e.checkin_date  === date)

            return (
              <div
                key={date}
                onClick={() => { setSelected(date); onDayClick?.(date) }}
                className={`relative p-1.5 min-h-[80px] cursor-pointer transition-colors ${
                  isSelected ? 'bg-sky-900/40' :
                  dayBookings.length > 0 ? 'bg-orange-950/30 hover:bg-orange-950/40' :
                  'bg-gray-900 hover:bg-gray-800/80'
                }`}
              >
                {/* Date number */}
                <div className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full mb-1 ${
                  isToday ? 'bg-sky-500 text-white' :
                  isSelected ? 'text-sky-400' :
                  'text-gray-400'
                }`}>
                  {parseInt(date.slice(8))}
                </div>

                {/* Guest stay indicator */}
                {dayBookings.length > 0 && (
                  <div className="text-[10px] text-orange-400/70 mb-0.5 truncate leading-tight">
                    {isCheckin && '→ '}
                    {dayBookings[0].property_name || 'Guest'}
                    {isCheckout && ' ✓'}
                  </div>
                )}

                {/* Job pills */}
                <div className="space-y-0.5">
                  {dayJobs.slice(0, 3).map(j => {
                    const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                    return (
                      <div
                        key={j.id}
                        onClick={e => { e.stopPropagation(); onJobClick?.(j) }}
                        className={`text-[10px] px-1.5 py-0.5 rounded border truncate leading-tight cursor-pointer hover:opacity-80 ${tc.pill}`}
                        title={j.title}
                      >
                        {j.start_time} {j.title}
                      </div>
                    )
                  })}
                  {dayJobs.length > 3 && (
                    <div className="text-[10px] text-gray-500 px-1">+{dayJobs.length - 3} more</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Day detail panel */}
      <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-gray-800">
          <div className="text-sm font-semibold text-white">
            {selected
              ? new Date(selected + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Select a day'}
          </div>
          {selected && (
            <div className="text-xs text-gray-500 mt-0.5">
              {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''}
              {selectedBookings.length > 0 && ` · ${selectedBookings.length} Airbnb booking${selectedBookings.length !== 1 ? 's' : ''}`}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin space-y-4">
          {/* Airbnb bookings */}
          {selectedBookings.length > 0 && (
            <div>
              <p className="text-[10px] text-orange-400 font-medium mb-2 uppercase tracking-wide">Airbnb Bookings</p>
              <div className="space-y-2">
                {selectedBookings.map(b => (
                  <div key={b.id} className="bg-orange-900/20 border border-orange-800/40 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Home className="w-3 h-3 text-orange-400 shrink-0" />
                      <span className="text-xs font-medium text-orange-300">{b.property_name}</span>
                    </div>
                    <div className="text-[10px] text-orange-400/70">{b.summary || 'Reserved'}</div>
                    <div className="text-[10px] text-gray-500 mt-1">
                      {b.checkin_date} → {b.checkout_date}
                      {b.checkout_date === selected && <span className="text-orange-400 ml-1">← checkout today</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Jobs */}
          {selectedJobs.length > 0 && (
            <div>
              <p className="text-[10px] text-gray-500 font-medium mb-2 uppercase tracking-wide">Jobs</p>
              <div className="space-y-2">
                {selectedJobs.map(j => {
                  const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                  return (
                    <div
                      key={j.id}
                      onClick={() => onJobClick?.(j)}
                      className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg p-3 cursor-pointer transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white truncate">{j.title}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{j.start_time} – {j.end_time}</div>
                          {j.address && <div className="text-xs text-gray-500 truncate mt-0.5">{j.address}</div>}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tc.pill}`}>{tc.label}</span>
                          <div className="flex gap-1">
                            {j.calendar_invite_sent && <span title="On Google Cal" className="text-[10px] text-indigo-400">📅</span>}
                            {j.sms_reminder_sent    && <span title="Reminder sent" className="text-[10px] text-green-400">✓</span>}
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
            <div className="text-center py-8 text-gray-600 text-sm">Nothing scheduled</div>
          )}

          {!selected && (
            <div className="text-center py-8 text-gray-600 text-sm">Click a day to see details</div>
          )}
        </div>
      </div>
    </div>
  )
}
