/**
 * "Today" on the Ops Board — the REAL Schedule day timeline, embedded.
 *
 * The owner asked to "immediately have eyes on the cal schedule in a little
 * box" on Home. This renders the same `DispatchTimeline` the Schedule page's
 * dispatch view uses — an actual vertical hour axis with positioned blocks —
 * rather than a second, lookalike list. One component, one visual language:
 * a job block on Home looks and behaves like the same block on /schedule.
 *
 * Data: one call to the existing /api/schedule/week aggregate for a single
 * day (from == to == today), which returns visits + jobs + properties +
 * clients in one round trip. Deliberately NO polling — Home already carries
 * the board fetch and a summary poll, and a schedule that's a minute stale
 * on a dashboard costs nothing (see the request-economy rules).
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { get } from '../../api'
import { toLocalYMD } from '../../utils/format'
import { useEmployees } from '../../hooks/useEmployees'
import DispatchTimeline from '../schedule/DispatchTimeline'

function indexById(list) {
  const map = {}
  for (const row of Array.isArray(list) ? list : []) map[row.id] = row
  return map
}

export default function TodayTimeline({ navigate }) {
  const [data, setData] = useState(null)     // { visits, jobs, properties, clients }
  const [state, setState] = useState('loading')  // loading | ready | error
  const { empName } = useEmployees()

  // api.js's `get` takes a URL only (no options/signal), so cancellation is a
  // plain "is this run still current" flag — a slow response after unmount
  // must not setState. Retry passes no canceller and always applies.
  const load = useCallback(async (isStale = () => false) => {
    setState('loading')
    const day = toLocalYMD(new Date())
    try {
      const res = await get(
        `/api/schedule/week?scheduled_date_from=${day}&scheduled_date_to=${day}`)
      if (isStale()) return
      setData({
        visits: Array.isArray(res?.visits) ? res.visits : [],
        jobs: indexById(res?.jobs),
        properties: indexById(res?.properties),
        clients: indexById(res?.clients),
      })
      setState('ready')
    } catch {
      if (isStale()) return
      setState('error')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  // Cancelled visits never render (DispatchTimeline filters them too) — this
  // count has to agree with what's actually drawn below it.
  const visits = (data?.visits || []).filter(v => v.status !== 'cancelled')

  const openVisit = (v, job) => {
    const id = job?.id ?? v?.job_id
    if (id) navigate(`/jobs/${id}`)
  }

  return (
    <section className="mb-4 break-inside-avoid overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">📅</span>
        <h2 className="text-[11px] font-medium text-ink-3">Today</h2>
        {state === 'ready' && (
          <span className="text-[11px] font-semibold tabular-nums text-ink-3">{visits.length}</span>
        )}
        <button onClick={() => navigate('/schedule')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          Schedule<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      {state === 'loading' && (
        <div className="p-3">
          <div className="h-[300px] animate-pulse rounded-2xl bg-bg-2" />
        </div>
      )}

      {state === 'error' && (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load today's schedule.</span>
          <button onClick={() => load()}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {/* Empty renders as one quiet line, not 300px of blank hour grid — the
          whole point of this box is to stop wasting vertical space. */}
      {state === 'ready' && visits.length === 0 && (
        <p className="px-3.5 py-4 text-center text-[12.5px] text-ink-3">
          Nothing on the schedule today.
        </p>
      )}

      {state === 'ready' && visits.length > 0 && (
        <div className="p-3">
          <DispatchTimeline
            visits={visits}
            jobs={data.jobs}
            properties={data.properties}
            clients={data.clients}
            empName={empName}
            onOpen={openVisit}
            hideHeader
            // Bounded so the 14-hour axis scrolls inside the card instead of
            // making Home enormously tall; opens near the current hour so the
            // working part of the day is what's on screen.
            className="h-[300px]"
            scrollToHour={new Date().getHours()}
          />
        </div>
      )}
    </section>
  )
}
