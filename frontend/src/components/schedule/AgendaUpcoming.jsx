import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarRange, Plus, RefreshCw } from 'lucide-react'
import { get } from '../../api'
import { toLocalYMD } from '../../utils/format'
import VisitCard from './VisitCard'

const HORIZON_DAYS = 45

const byId = (rows) => {
  const m = {}
  for (const r of rows || []) m[r.id] = r
  return m
}

/** "All upcoming" — one scrollable list of every upcoming visit grouped by day,
 *  so the whole schedule is scannable without flipping views. Fetches its own
 *  wide window (today → +45d) since the shared week/month hook only covers a
 *  narrow range. Cards + tap-to-open match the Day agenda exactly (VisitCard);
 *  each day header has a "+" to drop a new job straight onto that date. */
export default function AgendaUpcoming({
  onSelect, onCreateForDay, refreshKey = 0,
  propertyTypeFilter = 'all', statusFilter = 'all',
}) {
  const [data, setData] = useState(null)   // { visits, jobs, properties, clients }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const today = toLocalYMD(new Date())
  const end = useMemo(() => {
    const d = new Date(`${today}T00:00`)
    d.setDate(d.getDate() + HORIZON_DAYS)
    return toLocalYMD(d)
  }, [today])

  const load = useCallback(() => {
    setLoading(true); setError(false)
    get(`/api/schedule/week?scheduled_date_from=${today}&scheduled_date_to=${end}`)
      .then(d => setData(d || {}))
      .catch(() => { setData(null); setError(true) })
      .finally(() => setLoading(false))
  }, [today, end])

  useEffect(() => { load() }, [load, refreshKey])

  const jobsById = useMemo(() => byId(data?.jobs), [data])
  const propsById = useMemo(() => byId(data?.properties), [data])
  const clientsById = useMemo(() => byId(data?.clients), [data])

  // Group active visits by day (skip cancelled — this is a "what's coming"
  // list, not an audit), honor the toolbar's type/status filters, and sort
  // days ascending / within-day by start time.
  const groups = useMemo(() => {
    const visits = (data?.visits || []).filter(v => {
      if (v.status === 'cancelled') return false
      const job = jobsById[v.job_id]
      if (statusFilter !== 'all' && v.status !== statusFilter) return false
      if (propertyTypeFilter !== 'all') {
        const want = propertyTypeFilter === 'str' ? 'str_turnover' : propertyTypeFilter
        if ((job?.job_type || 'residential') !== want) return false
      }
      return true
    })
    const byDay = {}
    for (const v of visits) {
      const d = v.scheduled_date
      if (!d) continue
      ;(byDay[d] = byDay[d] || []).push(v)
    }
    return Object.keys(byDay).sort().map(date => ({
      date,
      visits: byDay[date].sort((a, b) =>
        (a.start_time || '99:99').slice(0, 5).localeCompare((b.start_time || '99:99').slice(0, 5))),
    }))
  }, [data, jobsById, propertyTypeFilter, statusFilter])

  const totalJobs = groups.reduce((n, g) => n + g.visits.length, 0)
  const fmtDay = (d) => new Date(`${d}T00:00`).toLocaleDateString('en-US',
    { weekday: 'long', month: 'short', day: 'numeric' })
  const relLabel = (d) => {
    if (d === today) return 'Today'
    const t = new Date(`${today}T00:00`); t.setDate(t.getDate() + 1)
    if (d === toLocalYMD(t)) return 'Tomorrow'
    return ''
  }

  if (loading && !data) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-3 py-3 space-y-2.5">
          {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-20 rounded-2xl bg-bg-2 animate-pulse" />)}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-3 py-10 text-center">
          <p className="text-[13px] text-ink-3">Couldn’t load the upcoming schedule.</p>
          <button onClick={load} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-indigo-600">
            <RefreshCw className="w-4 h-4" /> Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-3 pb-24 sm:pb-6">
        {/* Header band: what range you're looking at + total. */}
        <div className="sticky top-0 z-[6] -mx-3 px-3 pt-3 pb-2 mb-1 bg-bg border-b border-hairline/50 flex items-center gap-2">
          <span className="grid place-items-center w-8 h-8 shrink-0 text-indigo-600 dark:text-indigo-300">
            <CalendarRange className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-ink leading-tight">All upcoming</h2>
            <p className="text-[12px] text-ink-3">
              {totalJobs} job{totalJobs === 1 ? '' : 's'} · next {HORIZON_DAYS} days
            </p>
          </div>
          <button onClick={load} title="Refresh"
            className="ml-auto p-1.5 rounded-lg hover:bg-bg-2 text-ink-3 shrink-0">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="bg-panel border border-hairline rounded-2xl p-10 text-center mt-3">
            <CalendarRange className="w-8 h-8 text-ink-3 mx-auto mb-2" />
            <p className="text-[13px] text-ink-3">Nothing scheduled in the next {HORIZON_DAYS} days</p>
            <p className="text-[12px] text-ink-3 mt-2">
              Create a job, or <Link to="/properties" className="underline hover:text-ink-2">import a property’s iCal feed</Link>
            </p>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            {groups.map(g => (
              <section key={g.date}>
                {/* Day sub-header — sticks just under the page band while its
                    group scrolls, so you always know which day you're reading. */}
                <div className="sticky top-[3.25rem] z-[5] -mx-3 px-3 py-1.5 bg-bg/95 backdrop-blur-sm flex items-center gap-2">
                  <h3 className="text-[13px] font-bold text-ink">
                    {fmtDay(g.date)}
                    {relLabel(g.date) && (
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-indigo-600">{relLabel(g.date)}</span>
                    )}
                  </h3>
                  <span className="text-[11px] text-ink-3">{g.visits.length}</span>
                  {onCreateForDay && (
                    <button
                      onClick={() => onCreateForDay(g.date)}
                      className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 px-1.5 py-0.5 rounded-md hover:bg-indigo-500/10"
                      title={`Add a job on ${fmtDay(g.date)}`}
                    >
                      <Plus className="w-3.5 h-3.5" /> Add
                    </button>
                  )}
                </div>
                <ul className="space-y-2.5">
                  {g.visits.map(v => (
                    <li key={v.id}>
                      <VisitCard v={v} jobs={jobsById} properties={propsById} clients={clientsById} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
