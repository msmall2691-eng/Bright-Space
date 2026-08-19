/**
 * "Next 7 days" on the Ops Board — the week's work, grouped by day.
 *
 * Replaces the day-only timeline this box used to hold. The owner's problem
 * with a today-only view was blunt: a Wednesday with nothing scheduled showed
 * an empty box, even with Friday and Saturday turnovers on the books. A
 * dashboard that says "nothing today" while the week is full isn't telling
 * her what she needs to know.
 *
 * So: seven days, grouped, **empty days omitted entirely** (they're the
 * padding that made the old box useless). Each day header deep-links to that
 * day on /schedule, where the real hour-axis timeline lives — this box is for
 * "what's coming and is it covered", not for placing blocks on an axis.
 *
 * Data: one call to the existing /api/schedule/week aggregate — the same
 * endpoint and shape the Schedule page uses. No polling: Home already carries
 * the board fetch and a summary poll, and a dashboard that's a minute stale
 * costs nothing (see the request-economy rules).
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { get } from '../../api'
import { toLocalYMD } from '../../utils/format'
import { useEmployees } from '../../hooks/useEmployees'

const DAYS_AHEAD = 7

function indexById(list) {
  const map = {}
  for (const row of Array.isArray(list) ? list : []) map[row.id] = row
  return map
}

/** "9a", "10:30a", "2p" — the compact form the rest of the app uses. */
function fmtTime(t) {
  const m = /^(\d\d):(\d\d)/.exec(String(t || ''))
  if (!m) return ''
  const h = Number(m[1]), min = Number(m[2])
  const h12 = h % 12 || 12
  const ampm = h < 12 ? 'a' : 'p'
  return min ? `${h12}:${m[2]}${ampm}` : `${h12}${ampm}`
}

/** Date-only string → "Today" / "Tomorrow" / "Thu Aug 21". Parsed as LOCAL
 *  midnight (never `new Date("2026-08-13")`, which is UTC and renders as the
 *  previous day east of Greenwich). */
function dayLabel(ymd, todayYmd) {
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const [ty, tm, td] = todayYmd.split('-').map(Number)
  const today = new Date(ty, tm - 1, td)
  const delta = Math.round((date - today) / 86400000)
  if (delta === 0) return 'Today'
  if (delta === 1) return 'Tomorrow'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function UpcomingWeek({ navigate }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')  // loading | ready | error
  const { empName } = useEmployees()

  // api.js's `get` takes a URL only (no options/signal), so cancellation is a
  // plain "is this run still current" flag — a slow response after unmount
  // must not setState. Retry passes no canceller and always applies.
  const load = useCallback(async (isStale = () => false) => {
    setState('loading')
    const start = new Date()
    const end = new Date()
    end.setDate(end.getDate() + DAYS_AHEAD - 1)
    try {
      const res = await get(
        `/api/schedule/week?scheduled_date_from=${toLocalYMD(start)}&scheduled_date_to=${toLocalYMD(end)}`)
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

  const todayYmd = toLocalYMD(new Date())
  const visits = (data?.visits || []).filter(v => v.status !== 'cancelled')

  // Group by scheduled_date, chronological, with each day's visits sorted by
  // start time. Untimed visits sort last within their day rather than being
  // dropped — a job with no time set is legal here and still real work.
  const byDay = new Map()
  for (const v of visits) {
    const ymd = String(v.scheduled_date || '').slice(0, 10)
    if (!ymd) continue
    if (!byDay.has(ymd)) byDay.set(ymd, [])
    byDay.get(ymd).push(v)
  }
  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ymd, list]) => [
      ymd,
      [...list].sort((a, b) => String(a.start_time || '~').localeCompare(String(b.start_time || '~'))),
    ])

  const openVisit = (v) => {
    const id = v?.job_id ?? v?.id
    if (id) navigate(`/jobs/${id}`)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">📅</span>
        <h2 className="text-[11px] font-medium text-ink-3">Next 7 days</h2>
        {state === 'ready' && (
          <span className="text-[11px] font-semibold tabular-nums text-ink-3">{visits.length}</span>
        )}
        <button onClick={() => navigate('/schedule')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
          Schedule<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      {state === 'loading' && (
        <div className="space-y-2 p-3">
          {[0, 1, 2].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-bg-2" />)}
        </div>
      )}

      {state === 'error' && (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load the schedule.</span>
          <button onClick={() => load()}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {state === 'ready' && days.length === 0 && (
        <p className="px-3.5 py-4 text-center text-[12.5px] text-ink-3">
          Nothing booked in the next 7 days.
        </p>
      )}

      {state === 'ready' && days.length > 0 && (
        /* Bounded + scrollable so a heavy week can't make Home enormous. */
        <div className="max-h-[340px] overflow-y-auto">
          {days.map(([ymd, list]) => (
            <div key={ymd}>
              <button onClick={() => navigate(`/schedule?date=${ymd}`)}
                data-testid={`day-header-${ymd}`}
                className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-hairline bg-bg-2 px-3.5 py-1.5 text-left transition-colors hover:bg-hairline">
                <span className={`text-[11px] font-semibold ${ymd === todayYmd ? 'text-ink' : 'text-ink-2'}`}>
                  {dayLabel(ymd, todayYmd)}
                </span>
                <span className="text-[10.5px] tabular-nums text-ink-3">{list.length}</span>
              </button>
              <ul className="divide-y divide-hairline">
                {list.map(v => {
                  const job = data.jobs[v.job_id]
                  const prop = data.properties[job?.property_id]
                  const client = data.clients[job?.client_id]
                  const unassigned = (v.cleaner_ids?.length || 0) === 0
                  const crew = (v.cleaner_ids || []).map(id => empName?.(id)).filter(Boolean).join(' + ')
                  const time = fmtTime(v.start_time)
                  return (
                    <li key={v.id}>
                      <button onClick={() => openVisit(v)}
                        className="flex w-full items-baseline gap-2 px-3.5 py-2 text-left transition-colors hover:bg-bg-2">
                        <span className="w-12 shrink-0 text-[11px] tabular-nums text-ink-3">
                          {time || '—'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                          {prop?.name || client?.name || job?.title || `Visit ${v.id}`}
                        </span>
                        {/* Dot + word, never a filled pill (owner veto). */}
                        {unassigned ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                            Needs cleaner
                          </span>
                        ) : (
                          <span className="shrink-0 truncate text-[10.5px] text-ink-3">{crew}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
