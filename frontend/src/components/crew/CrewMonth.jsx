/**
 * Crew Schedule tab — Month view.
 *
 * A phone-first month grid of the cleaner's jobs (blue dots). Leads the
 * admin flagged (can_view_full_schedule) also see everyone else's jobs as
 * gray dots — names/times only; the backend strips access details from
 * rows that aren't theirs. Tap a day for its list below the grid.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, KeyRound, MapPin, ParkingCircle, Users, X } from 'lucide-react'
import { get } from '../../api'

/** Tap-through detail sheet for one of MY jobs from the month grid — the
 *  full card context (address, code, notes, checklist, teammates) fetched
 *  from /api/crew/jobs/{id}. Other people's jobs don't open (no details to
 *  show by design). */
function MonthJobSheet({ jobId, onClose }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let cancelled = false
    get(`/api/crew/jobs/${jobId}`)
      .then(d => { if (!cancelled) setJob(d) })
      .catch(e => { if (!cancelled) setError(e.detail || e.message || 'Could not load') })
    return () => { cancelled = true }
  }, [jobId])
  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
      onClick={onClose}>
      <div className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-3 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-base font-bold text-ink truncate">
              {job ? (job.property_name || job.title) : 'Loading…'}
            </div>
            {job && (
              <div className="text-[12px] text-ink-3">
                {new Date(`${job.scheduled_date}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                {job.start_time ? ` · ${job.start_time}${job.end_time ? `–${job.end_time}` : ''}` : ''}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 grid place-items-center w-8 h-8 rounded-lg bg-bg-2 text-ink-3">
            <X className="w-4 h-4" />
          </button>
        </div>
        {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {!job && !error && <div className="h-32 rounded-xl bg-bg-2 animate-pulse" />}
        {job && (
          <div className="space-y-2 text-[13px] text-ink-2">
            {job.address && (
              <div className="flex items-start gap-1.5"><MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.address}</div>
            )}
            {job.house_code && (
              <div className="flex items-start gap-1.5"><KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> Code {job.house_code}</div>
            )}
            {job.access_notes && (
              <div className="flex items-start gap-1.5"><KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.access_notes}</div>
            )}
            {job.parking_notes && (
              <div className="flex items-start gap-1.5"><ParkingCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.parking_notes}</div>
            )}
            {job.notes && (
              <div className="rounded-lg bg-blue-500/5 border border-blue-500/15 px-3 py-2 text-[12px] whitespace-pre-wrap">
                <span className="font-semibold text-ink">From the office: </span>{job.notes}
              </div>
            )}
            {job.teammates?.length > 0 && (
              <div className="flex items-start gap-1.5"><Users className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> With {job.teammates.join(', ')}</div>
            )}
            {job.checklist_template && (
              <div className="text-[12px] text-ink-3 whitespace-pre-wrap border-t border-hairline pt-2">{job.checklist_template}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']   // Sunday-first, US calendar
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export default function CrewMonth() {
  const now = new Date()
  const [anchor, setAnchor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(ymd(now))
  const [openJobId, setOpenJobId] = useState(null)

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
            {dayJobs.map(j => {
              const Row = j.mine ? 'button' : 'div'
              return (
                <Row key={j.id}
                  {...(j.mine ? { onClick: () => setOpenJobId(j.id) } : {})}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 ${
                    j.mine ? 'bg-panel border-hairline active:scale-[0.99] transition-transform' : 'bg-bg-2 border-transparent'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] font-semibold min-w-0 truncate ${j.mine ? 'text-ink' : 'text-ink-2'}`}>
                      {j.property_name || j.title}{j.mine ? ' · you' : ''}
                    </span>
                    <span className="text-[11.5px] font-mono text-ink-3 shrink-0">
                      {j.start_time ? `${j.start_time}${j.end_time ? `–${j.end_time}` : ''}` : 'anytime'}
                      {j.mine && <span className="text-blue-500 ml-1">›</span>}
                    </span>
                  </div>
                  {!j.mine && j.cleaners.length > 0 && (
                    <div className="text-[11px] text-ink-3 mt-0.5">{j.cleaners.join(', ')}</div>
                  )}
                </Row>
              )
            })}
          </div>
        </>
      )}
      {openJobId && <MonthJobSheet jobId={openJobId} onClose={() => setOpenJobId(null)} />}
    </div>
  )
}
