/**
 * Crew Schedule tab — Month view.
 *
 * A phone-first month grid of the cleaner's jobs (blue dots). Leads the
 * admin flagged (can_view_full_schedule) also see everyone else's jobs as
 * gray dots — names/times only; the backend strips access details from
 * rows that aren't theirs. Tap a day for its list below the grid.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Users } from 'lucide-react'
import { get } from '../../api'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']   // Sunday-first, US calendar
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export default function CrewMonth() {
  const now = new Date()
  const [anchor, setAnchor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(ymd(now))

  useEffect(() => {
    let cancelled = false
    setData(null); setError(null)
    get(`/api/crew/schedule-month?year=${anchor.year}&month=${anchor.month}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.detail || e.message || 'Could not load') })
    return () => { cancelled = true }
  }, [anchor])

  const byDate = useMemo(() => {
    const m = {}
    for (const j of (data?.jobs || [])) (m[j.date] = m[j.date] || []).push(j)
    return m
  }, [data])

  const cells = useMemo(() => {
    const first = new Date(anchor.year, anchor.month - 1, 1)
    const start = new Date(first); start.setDate(1 - first.getDay())   // back to Sunday
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i)
      return d
    })
  }, [anchor])

  const label = new Date(anchor.year, anchor.month - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const move = (delta) => setAnchor(a => {
    const d = new Date(a.year, a.month - 1 + delta, 1)
    return { year: d.getFullYear(), month: d.getMonth() + 1 }
  })
  const todayStr = ymd(new Date())
  const dayJobs = byDate[selected] || []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => move(-1)} aria-label="Previous month"
          className="grid place-items-center w-8 h-8 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-center">
          <div className="text-[13px] font-bold text-ink">{label}</div>
          {data?.see_all && (
            <div className="text-[10px] text-ink-3 inline-flex items-center gap-1">
              <Users className="w-3 h-3" /> whole crew · gray = others
            </div>
          )}
        </div>
        <button onClick={() => move(1)} aria-label="Next month"
          className="grid place-items-center w-8 h-8 rounded-lg bg-bg-2 text-ink-2 active:scale-95 transition-transform">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      {!data && !error && <div className="h-64 rounded-xl bg-bg-2 animate-pulse" />}

      {data && (
        <>
          <div className="bg-panel border border-hairline rounded-xl p-2">
            <div className="grid grid-cols-7 mb-1">
              {DOW.map((d, i) => (
                <div key={i} className="text-center text-[10px] font-semibold text-ink-3">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-1">
              {cells.map((d, i) => {
                const k = ymd(d)
                const inMonth = d.getMonth() === anchor.month - 1
                const jobs = byDate[k] || []
                const mineCount = jobs.filter(j => j.mine).length
                const otherCount = jobs.length - mineCount
                return (
                  <button key={i} onClick={() => setSelected(k)}
                    className={`relative h-10 rounded-lg text-[12px] transition-colors ${
                      selected === k ? 'bg-blue-600 text-white font-bold'
                        : k === todayStr ? 'bg-blue-500/10 text-ink font-semibold'
                        : inMonth ? 'text-ink-2 hover:bg-bg-2' : 'text-ink-3/40'}`}>
                    {d.getDate()}
                    {(mineCount > 0 || otherCount > 0) && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5">
                        {mineCount > 0 && <span className={`w-1.5 h-1.5 rounded-full ${selected === k ? 'bg-white' : 'bg-blue-500'}`} />}
                        {otherCount > 0 && <span className={`w-1.5 h-1.5 rounded-full ${selected === k ? 'bg-white/60' : 'bg-ink-3/50'}`} />}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              {new Date(`${selected}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
            {dayJobs.length === 0 && (
              <p className="text-[12.5px] text-ink-3">Nothing scheduled.</p>
            )}
            {dayJobs.map(j => (
              <div key={j.id}
                className={`rounded-xl border px-3 py-2.5 ${j.mine ? 'bg-panel border-hairline' : 'bg-bg-2 border-transparent'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[13px] font-semibold min-w-0 truncate ${j.mine ? 'text-ink' : 'text-ink-2'}`}>
                    {j.property_name || j.title}{j.mine ? ' · you' : ''}
                  </span>
                  <span className="text-[11.5px] font-mono text-ink-3 shrink-0">
                    {j.start_time ? `${j.start_time}${j.end_time ? `–${j.end_time}` : ''}` : 'anytime'}
                  </span>
                </div>
                {!j.mine && j.cleaners.length > 0 && (
                  <div className="text-[11px] text-ink-3 mt-0.5">{j.cleaners.join(', ')}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
