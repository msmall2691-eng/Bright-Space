/**
 * The schedule box on Home — a real calendar grid, Week or Month.
 *
 * The owner asked for "a monthly view or weekly view of schedule" in a box.
 * Earlier attempts here were lists (a day rundown, then a week grouped by
 * day); a list tells you what's next but not the SHAPE of the week — which
 * days are packed, which are empty, where the gaps are. A grid does.
 *
 * Deliberately NOT reusing the Schedule page's `MonthDayCell`: that carries
 * drag-and-drop, touch-drag, quick-add and expand-in-place machinery bound to
 * CalendarView's state. Dragging all of that onto a dashboard widget would be
 * a lot of surface for a box you mostly look at. This is a read-only grid;
 * clicking any day opens it on the real Schedule where those tools live.
 *
 * Data: one call to /api/schedule/week for whatever range is on screen — the
 * same aggregate the Schedule page uses. Refetches when you change month or
 * mode; no polling (Home already carries the board fetch and a summary poll).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { get } from '../../api'
import { toLocalYMD } from '../../utils/format'

const MODE_KEY = 'brightbase_home_cal_mode'
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday-start weekday index (the app's week runs Mon–Sun). */
const mondayIndex = (d) => (d.getDay() + 6) % 7

function startOfWeek(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  s.setDate(s.getDate() - mondayIndex(s))
  return s
}

/** The Mon-start grid covering an entire month (always whole weeks). */
function monthGridRange(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const start = startOfWeek(first)
  const end = new Date(last)
  end.setDate(end.getDate() + (6 - mondayIndex(last)))
  return [start, end]
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}

function eachDay(start, end) {
  const out = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

export default function ScheduleCalendar({ navigate }) {
  // Remembered per device — she works in one of these two most days.
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(MODE_KEY) === 'month' ? 'month' : 'week' }
    catch { return 'week' }
  })
  const [anchor, setAnchor] = useState(() => new Date())
  const [visits, setVisits] = useState([])
  // Indexed lookups so an expanded day can label a visit with the PROPERTY or
  // client name — a job's own `title` is usually something generic like
  // "Turnover", which doesn't tell you which house.
  const [lookups, setLookups] = useState({ properties: {}, clients: {} })
  const [state, setState] = useState('loading')  // loading | ready | error
  const [openDay, setOpenDay] = useState(null)   // ymd of the expanded day

  const setModeSticky = (m) => {
    setMode(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* storage unavailable */ }
  }

  const [rangeStart, rangeEnd] = useMemo(() => (
    mode === 'month' ? monthGridRange(anchor) : [startOfWeek(anchor), addDays(startOfWeek(anchor), 6)]
  ), [mode, anchor])

  const fromYmd = toLocalYMD(rangeStart)
  const toYmd = toLocalYMD(rangeEnd)

  // api.js's `get` takes a URL only (no signal), so cancellation is a plain
  // "is this run still current" flag — a slow response for a month you've
  // already paged away from must not overwrite the one on screen.
  const load = useCallback(async (isStale = () => false) => {
    setState('loading')
    try {
      const res = await get(
        `/api/schedule/week?scheduled_date_from=${fromYmd}&scheduled_date_to=${toYmd}`)
      if (isStale()) return
      const index = (list) => {
        const map = {}
        for (const row of Array.isArray(list) ? list : []) map[row.id] = row
        return map
      }
      setVisits((Array.isArray(res?.visits) ? res.visits : [])
        .filter(v => v.status !== 'cancelled'))
      setLookups({ properties: index(res?.properties), clients: index(res?.clients) })
      setState('ready')
    } catch {
      if (isStale()) return
      setState('error')
    }
  }, [fromYmd, toYmd])

  useEffect(() => {
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  // ymd -> { total, unassigned, list }
  const byDay = useMemo(() => {
    const map = new Map()
    for (const v of visits) {
      const ymd = String(v.scheduled_date || '').slice(0, 10)
      if (!ymd) continue
      if (!map.has(ymd)) map.set(ymd, { total: 0, unassigned: 0, list: [] })
      const bucket = map.get(ymd)
      bucket.total += 1
      if ((v.cleaner_ids?.length || 0) === 0) bucket.unassigned += 1
      bucket.list.push(v)
    }
    for (const bucket of map.values()) {
      bucket.list.sort((a, b) =>
        String(a.start_time || '~').localeCompare(String(b.start_time || '~')))
    }
    return map
  }, [visits])

  const days = useMemo(() => eachDay(rangeStart, rangeEnd), [rangeStart, rangeEnd])
  const todayYmd = toLocalYMD(new Date())
  const step = (dir) => {
    setOpenDay(null)
    setAnchor(a => mode === 'month'
      ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
      : addDays(a, dir * 7))
  }

  const title = mode === 'month'
    ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : `${rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${rangeEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`

  const openDetail = openDay ? byDay.get(openDay) : null

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none">📅</span>
        <h2 className="text-[11px] font-medium text-ink-3">Schedule</h2>

        {/* Week | Month. Quiet segmented control, not filled pills. */}
        <div className="ml-1 flex items-center gap-0.5 rounded-md bg-bg-2 p-0.5">
          {['week', 'month'].map(m => (
            <button key={m} onClick={() => setModeSticky(m)}
              aria-pressed={mode === m}
              className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                mode === m ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
              {m}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => step(-1)} aria-label="Previous"
            className="grid h-6 w-6 place-items-center rounded text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-0 whitespace-nowrap text-[11px] font-medium text-ink-2">{title}</span>
          <button onClick={() => step(1)} aria-label="Next"
            className="grid h-6 w-6 place-items-center rounded text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => navigate('/schedule')}
            className="ml-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
            Open<ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </header>

      {state === 'error' ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load the schedule.</span>
          <button onClick={() => load()}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      ) : (
        <div className={state === 'loading' ? 'animate-pulse opacity-50' : ''}>
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b border-hairline bg-bg-2/50">
            {WEEKDAYS.map(w => (
              <div key={w} className="px-1 py-1 text-center text-[10px] font-medium text-ink-3">
                {w.slice(0, mode === 'month' ? 1 : 3)}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {days.map(d => {
              const ymd = toLocalYMD(d)
              const bucket = byDay.get(ymd)
              const inMonth = mode === 'week' || d.getMonth() === anchor.getMonth()
              const isToday = ymd === todayYmd
              const isOpen = ymd === openDay
              return (
                <button key={ymd}
                  onClick={() => setOpenDay(cur => (cur === ymd ? null : ymd))}
                  data-testid={`cal-day-${ymd}`}
                  aria-pressed={isOpen}
                  className={`flex min-h-[52px] flex-col items-center gap-1 border-b border-r border-hairline px-1 py-1.5 text-center transition-colors last:border-r-0 hover:bg-bg-2 ${
                    isOpen ? 'bg-bg-2' : ''
                  } ${inMonth ? '' : 'opacity-40'}`}>
                  <span className={`text-[11px] tabular-nums ${
                    isToday ? 'font-bold text-indigo-600 dark:text-indigo-400' : 'text-ink-2'}`}>
                    {d.getDate()}
                  </span>
                  {bucket ? (
                    <span className="flex flex-col items-center gap-0.5">
                      <span className="text-[12px] font-semibold leading-none text-ink">{bucket.total}</span>
                      {/* Dot + word is the house style; here the count is the
                          word, so an amber dot alone flags "some unassigned". */}
                      {bucket.unassigned > 0 && (
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500"
                          aria-label={`${bucket.unassigned} unassigned`} />
                      )}
                    </span>
                  ) : (
                    <span className="text-[11px] leading-none text-ink-3">·</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Tapping a day expands it in place — the grid shows shape, this
              shows the actual work, without leaving Home. */}
          {openDetail && (
            <div className="border-t border-hairline">
              <div className="flex items-center gap-2 bg-bg-2 px-3.5 py-1.5">
                <span className="text-[11px] font-semibold text-ink">
                  {new Date(`${openDay}T00:00:00`).toLocaleDateString(undefined,
                    { weekday: 'long', month: 'short', day: 'numeric' })}
                </span>
                <span className="text-[10.5px] tabular-nums text-ink-3">{openDetail.total}</span>
                <button onClick={() => navigate(`/schedule?date=${openDay}`)}
                  className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 transition-all hover:gap-1 dark:text-indigo-400">
                  Open day<ArrowRight className="h-3 w-3" />
                </button>
              </div>
              <ul className="max-h-[180px] divide-y divide-hairline overflow-y-auto">
                {openDetail.list.map(v => {
                  const unassigned = (v.cleaner_ids?.length || 0) === 0
                  const t = String(v.start_time || '').slice(0, 5)
                  return (
                    <li key={v.id}>
                      <button onClick={() => navigate(`/jobs/${v.job_id ?? v.id}`)}
                        className="flex w-full items-baseline gap-2 px-3.5 py-2 text-left transition-colors hover:bg-bg-2">
                        <span className="w-11 shrink-0 text-[11px] tabular-nums text-ink-3">{t || '—'}</span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                          {lookups.properties[v.property_id]?.name
                            || lookups.clients[v.client_id]?.name
                            || v.title || v.address || `Visit ${v.id}`}
                        </span>
                        {unassigned && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                            Needs cleaner
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {state === 'ready' && visits.length === 0 && !openDetail && (
            <p className="px-3.5 py-3 text-center text-[12.5px] text-ink-3">
              Nothing booked {mode === 'month' ? 'this month' : 'this week'}.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
