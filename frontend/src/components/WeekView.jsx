import { useState, useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight, User, Users, X, MapPin, Clock, AlertTriangle } from 'lucide-react'
import { get, post } from '../api'

const TYPE_DOT = {
  residential:  'bg-blue-500',
  commercial:   'bg-green-500',
  str_turnover: 'bg-orange-500',
}

const STATUS_PILL = {
  scheduled:   'bg-blue-50 text-blue-700 border-blue-200',
  dispatched:  'bg-indigo-50 text-indigo-700 border-indigo-200',
  en_route:    'bg-amber-50 text-amber-700 border-amber-200',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-200',
  completed:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled:   'bg-zinc-100 text-zinc-400 border-zinc-200 line-through',
  no_show:     'bg-rose-50 text-rose-700 border-rose-200',
}

const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function startOfWeek(d) {
  // Monday-first week
  const date = new Date(d)
  const day = date.getDay() // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day)
  date.setDate(date.getDate() + diff)
  date.setHours(12, 0, 0, 0)
  return date
}

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtRange(monday) {
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  const opts = { month: 'short', day: 'numeric' }
  return `${monday.toLocaleDateString(undefined, opts)} – ${sunday.toLocaleDateString(undefined, opts)}, ${sunday.getFullYear()}`
}

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = String(t).split(':')
  const hour = parseInt(h, 10)
  const ampm = hour >= 12 ? 'p' : 'a'
  const h12 = hour % 12 || 12
  return `${h12}:${m}${ampm}`
}

export default function WeekView({ filters = {}, onVisitClick, refreshKey = 0, employees = [] }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [visits, setVisits] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [internalRefresh, setInternalRefresh] = useState(0)

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart)
      d.setDate(d.getDate() + i)
      return { date: d, iso: isoDate(d) }
    })
  }, [weekStart])

  // Fetch visits for the week
  useEffect(() => {
    const from = isoDate(weekStart)
    const to = isoDate(new Date(weekStart.getTime() + 6 * 86400000))
    setLoading(true)
    setError(null)
    get(`/api/visits?scheduled_date_from=${from}&scheduled_date_to=${to}&limit=500`)
      .then(data => {
        const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : [])
        setVisits(items)
      })
      .catch(e => setError(e?.message || 'Failed to load visits'))
      .finally(() => setLoading(false))
  }, [weekStart, refreshKey, internalRefresh])

  // Apply filters in JS (job_type, status, property_id) — same as month view does
  const filteredVisits = useMemo(() => {
    return visits.filter(v => {
      if (filters.job_type && v.job?.job_type !== filters.job_type) return false
      if (filters.status && v.status !== filters.status) return false
      if (filters.property_id && String(v.property?.id) !== String(filters.property_id)) return false
      return true
    })
  }, [visits, filters])

  // Group visits by cleaner_id × date
  // Visits with no cleaner go into the "Unassigned" row.
  const grid = useMemo(() => {
    const byCleaner = new Map() // cleanerId (or 'unassigned') → { [iso]: visit[] }
    byCleaner.set('unassigned', {})

    for (const v of filteredVisits) {
      const cleanerIds = (v.cleaner_ids || []).map(String)
      const buckets = cleanerIds.length > 0 ? cleanerIds : ['unassigned']
      const dateKey = v.scheduled_date

      for (const cid of buckets) {
        if (!byCleaner.has(cid)) byCleaner.set(cid, {})
        const byDate = byCleaner.get(cid)
        if (!byDate[dateKey]) byDate[dateKey] = []
        byDate[dateKey].push(v)
      }
    }
    return byCleaner
  }, [filteredVisits])

  // Build the row order: cleaners with visits this week first, then other employees, with Unassigned pinned to top
  const rows = useMemo(() => {
    const cleanerIdsWithVisits = new Set(
      [...grid.keys()].filter(k => k !== 'unassigned')
    )
    const empMap = new Map(employees.map(e => [String(e.id), e]))

    const named = [...cleanerIdsWithVisits]
      .map(id => ({ id, employee: empMap.get(id) || null, hasVisits: true }))
      .sort((a, b) => {
        const an = a.employee?.name || a.employee?.displayName || a.id
        const bn = b.employee?.name || b.employee?.displayName || b.id
        return String(an).localeCompare(String(bn))
      })

    const otherEmployees = employees
      .filter(e => !cleanerIdsWithVisits.has(String(e.id)))
      .map(e => ({ id: String(e.id), employee: e, hasVisits: false }))

    return [
      { id: 'unassigned', employee: null, hasVisits: (grid.get('unassigned') || {}) },
      ...named,
      ...otherEmployees,
    ]
  }, [grid, employees])

  const todayIso = isoDate(new Date())

  const goPrev = () => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() - 7)
    setWeekStart(d)
  }
  const goNext = () => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    setWeekStart(d)
  }
  const goToday = () => setWeekStart(startOfWeek(new Date()))

  const handleSkip = async (visitId) => {
    const reason = window.prompt('Reason to skip this visit? (optional)')
    if (reason === null) return  // user cancelled the prompt itself
    try {
      await post(`/api/visits/${visitId}/skip${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`)
      setInternalRefresh(k => k + 1)
    } catch (e) {
      alert('Failed to skip visit: ' + (e?.message || 'unknown error'))
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={goPrev} className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500" aria-label="Previous week">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={goToday} className="text-xs px-2.5 py-1 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50">
            Today
          </button>
          <button onClick={goNext} className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500" aria-label="Next week">
            <ChevronRight className="w-4 h-4" />
          </button>
          <h3 className="ml-2 text-sm font-semibold text-zinc-900">{fmtRange(weekStart)}</h3>
        </div>
        <div className="text-[11px] text-zinc-400">
          {loading ? 'Loading…' : `${filteredVisits.length} visit${filteredVisits.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {error && (
        <div className="mx-4 my-2 rounded border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {/* Scrollable grid */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-xs" style={{ minWidth: 900 }}>
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              <th className="text-left text-[10px] uppercase tracking-wide text-zinc-400 font-medium border-b border-r border-zinc-200 px-3 py-2 sticky left-0 bg-white" style={{ width: 180 }}>
                Cleaner
              </th>
              {days.map(d => {
                const isToday = d.iso === todayIso
                return (
                  <th key={d.iso}
                    className={`text-left text-[10px] uppercase tracking-wide font-medium border-b border-zinc-200 px-3 py-2 ${
                      isToday ? 'bg-blue-50 text-blue-700' : 'text-zinc-400'
                    }`}>
                    <div>{DAY_LABELS[d.date.getDay() === 0 ? 6 : d.date.getDay() - 1]}</div>
                    <div className={`text-base font-semibold ${isToday ? 'text-blue-700' : 'text-zinc-700'}`}>
                      {d.date.getDate()}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const byDate = grid.get(row.id) || {}
              const isUnassigned = row.id === 'unassigned'
              const name = isUnassigned
                ? 'Unassigned'
                : (row.employee?.name || row.employee?.displayName || `Cleaner #${row.id}`)
              return (
                <tr key={row.id} className="border-b border-zinc-100 hover:bg-zinc-50/50">
                  <td
                    className={`px-3 py-2 border-r border-zinc-200 sticky left-0 ${isUnassigned ? 'bg-amber-50' : 'bg-white'}`}
                    style={{ width: 180 }}
                  >
                    <div className="flex items-center gap-2">
                      {isUnassigned
                        ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        : <User className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      }
                      <span className={`text-xs font-medium truncate ${isUnassigned ? 'text-amber-800' : 'text-zinc-700'}`}>
                        {name}
                      </span>
                    </div>
                  </td>
                  {days.map(d => {
                    const cellVisits = byDate[d.iso] || []
                    return (
                      <td key={d.iso} className="align-top border-r border-zinc-100 p-1.5" style={{ minWidth: 130, height: 80 }}>
                        <div className="flex flex-col gap-1">
                          {cellVisits.map(v => (
                            <VisitCard
                              key={v.id}
                              visit={v}
                              onClick={() => onVisitClick?.(v)}
                              onSkip={() => handleSkip(v.id)}
                            />
                          ))}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VisitCard({ visit, onClick, onSkip }) {
  const jobType = visit.job?.job_type || 'residential'
  const status = visit.status || 'scheduled'
  const title = visit.job?.title || 'Visit'
  const propName = visit.property?.name
  const isCancelled = status === 'cancelled'

  return (
    <div
      onClick={onClick}
      className={`group relative rounded border px-2 py-1 cursor-pointer transition-colors ${STATUS_PILL[status] || STATUS_PILL.scheduled}`}
      title={`${title} — ${propName || ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TYPE_DOT[jobType] || 'bg-zinc-400'}`} />
        <span className="text-[11px] font-medium truncate flex-1">{title}</span>
        {!isCancelled && onSkip && (
          <button
            onClick={(e) => { e.stopPropagation(); onSkip() }}
            className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-rose-600 transition-opacity"
            title="Skip this visit (recurring rule unchanged)"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-[10px] opacity-80 mt-0.5">
        <Clock className="w-2.5 h-2.5" />
        <span>{fmtTime(visit.start_time)}–{fmtTime(visit.end_time)}</span>
      </div>
      {propName && (
        <div className="flex items-center gap-1 text-[10px] opacity-70 truncate">
          <MapPin className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{propName}</span>
        </div>
      )}
    </div>
  )
}
