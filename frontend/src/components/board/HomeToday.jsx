import { useMemo } from 'react'
import { ArrowRight, RefreshCw, User } from 'lucide-react'
import { useScheduleData } from '../../hooks/useScheduleData'
import { daysInRange } from '../../utils/dateRange'
import { todayYMD } from '../../utils/format'
import NeedsDateStrip from '../schedule/NeedsDateStrip'
import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'

/**
 * Today's visits as a COMPACT list — the glanceable replacement for the full
 * month calendar that used to sit on Home (the real calendar stays on
 * /schedule). It reuses the exact same /api/schedule/week aggregate the Home
 * calendar used (useScheduleData), just filtered to today and rendered as rows
 * instead of a grid, so it costs the same one schedule fetch — no new request
 * (brightbase-economy). The 3-minute poll matches the old Home calendar: Home
 * is a glance surface, not where two admins edit against each other.
 *
 * Each row: time · status dot · client · service, with the assigned cleaner by
 * name or a quiet amber "needs a cleaner" cue (dot + word, never a tinted
 * capsule). Tapping a row opens the job; "Open schedule →" hands off to the
 * full calendar.
 *
 * THREE THINGS RIDE THAT ONE FETCH, not one. The `/api/schedule/week` response
 * is a whole Sunday–Saturday week plus the date-less jobs, and this component
 * used to keep one day of it and discard the rest:
 *
 *   - today's rows (the original job)
 *   - the WEEK RAIL — the same `visits` grouped by `scheduled_date` instead of
 *     filtered to one, so the week's shape costs nothing. There is no
 *     `week_load` field in the board payload and there must not be one.
 *   - NEEDS A DATE — the `unscheduled` array the response already carries
 *     (office roles only; crew receive `[]`). Accepting a quote converts it to
 *     a job with no date, and a date-bounded week query can never show those.
 *
 * All three MUST stay inside this component. `useScheduleData` keeps its state
 * in per-instance refs with no module-level cache and no in-flight map, so a
 * second mount anywhere on this page is a second identical request
 * (brightbase-economy). Mounting the rail from OpsBoard would double the
 * schedule fetch, and the test that counts requests is there to catch it.
 */
function statusDot(v, job) {
  const cleanerIds = v.cleaner_ids?.length ? v.cleaner_ids : job?.cleaner_ids
  if (v.status === 'completed') return { cls: STATUS_DOT.ok, label: 'Done' }
  if (v.status === 'cancelled') return { cls: 'bg-ink-3', label: 'Cancelled' }
  if (Array.isArray(cleanerIds) && cleanerIds.length === 0) return { cls: STATUS_DOT.attention, label: 'Needs a cleaner' }
  return { cls: 'bg-indigo-500', label: 'Scheduled' }
}

/**
 * The week's shape in seven columns — day initial over a plain count.
 *
 * Today is marked by INK WEIGHT and a hairline underline, not a fill: a filled
 * cell on a seven-cell strip reads as a selected tab, and the owner has vetoed
 * the whole family of coloured blocks. A day with nothing on it shows a dim
 * dash rather than a 0, so the eye skips it instead of reading it as data.
 * Each cell is a real link to that day on the calendar.
 */
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
// Spoken, not shown. The visible cell is three terse glyphs — "S", "2", "5" —
// which is exactly what a screen reader would read out, and `title` is not
// reliably announced. Each cell gets a sentence instead.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function WeekRail({ days, countFor, today, navigate }) {
  // Nothing fetched yet, or a malformed range — the rest of the card still works.
  if (!days.length) return null
  return (
    <div data-testid="home-week-rail"
      className="flex items-stretch border-b border-hairline">
      {days.map(ymd => {
        const n = countFor(ymd)
        const isToday = ymd === today
        const [, , dd] = ymd.split('-')
        // Parsed with no zone suffix, so local — and `ymd` came from a local
        // Date, so it round-trips. Taken from the date rather than the array
        // index, which would only be right for a Sunday-aligned range.
        const dow = new Date(`${ymd}T12:00`).getDay()
        const spoken = `${DAY_NAMES[dow]} the ${Number(dd)}${isToday ? ', today' : ''} — ${
          n === 0 ? 'nothing booked' : `${n} ${n === 1 ? 'job' : 'jobs'}`}`
        return (
          <button key={ymd} type="button"
            onClick={() => navigate(`/schedule?view=day&date=${ymd}`)}
            aria-current={isToday ? 'date' : undefined}
            aria-label={spoken}
            title={spoken}
            className={`bb-focus min-w-0 flex-1 px-1 py-2 text-center transition-colors hover:bg-bg-2 ${
              isToday ? 'border-b-2 border-ink' : ''
            }`}>
            <span className={`block text-[10px] leading-none ${isToday ? 'font-semibold text-ink-2' : 'text-ink-3'}`}>
              {DAY_INITIALS[dow]}
            </span>
            <span className={`mt-1 block text-[13px] font-semibold leading-none tabular-nums ${
              n === 0 ? 'text-ink-3/60' : isToday ? 'text-ink' : 'text-ink-2'
            }`}>
              {n === 0 ? '–' : n}
            </span>
            <span className="mt-0.5 block text-[9.5px] leading-none text-ink-3/70 tabular-nums">{Number(dd)}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function HomeToday({ navigate }) {
  const { visits, jobs, clients, unscheduled, range, loading, loadError, refresh, empName } =
    useScheduleData(new Date(), 'week', { pollMs: 180000 })

  const today = todayYMD()

  // One pass over `visits` keyed by day, used by BOTH today's rows and the
  // rail — the rail is a different read of the same array, never a second
  // fetch and never a second traversal.
  const byDay = useMemo(() => {
    const map = new Map()
    for (const v of visits || []) {
      const d = v.scheduled_date || jobs[v.job_id]?.scheduled_date
      if (!d) continue
      const bucket = map.get(d)
      if (bucket) bucket.push(v)
      else map.set(d, [v])
    }
    return map
  }, [visits, jobs])

  const rows = useMemo(() => {
    const list = byDay.get(today) || []
    return [...list].sort((a, b) => (a.start_time || '99').localeCompare(b.start_time || '99'))
  }, [byDay, today])

  // Day keys come from the RANGE that was fetched, not from the visits, so a
  // day with nothing booked still gets a column.
  const days = useMemo(() => daysInRange(range?.start, range?.end), [range])

  return (
    <>
    <section data-testid="home-today" className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Today</h2>
        {!loading && !loadError && (
          <span className="text-[11px] font-semibold tabular-nums text-ink-3">{rows.length}</span>
        )}
        <button
          onClick={() => navigate('/schedule')}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
          Open schedule<ArrowRight className="h-3 w-3" />
        </button>
      </header>

      {/* The week, above today. One card, one subject: the schedule — today
          expanded, the rest of the week as shape. Hidden while the first paint
          is still a skeleton so the row doesn't appear and then re-count. */}
      {!loading && !loadError && (
        <WeekRail days={days} countFor={d => (byDay.get(d) || []).length}
          today={today} navigate={navigate} />
      )}

      {loading ? (
        <div className="divide-y divide-hairline">
          {[0, 1, 2].map(i => <div key={i} className="h-11 animate-pulse bg-bg-2/40" />)}
        </div>
      ) : loadError ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load today's schedule.</span>
          <button onClick={refresh}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-link hover:text-link">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.ok}`} aria-hidden="true" />
          <span className="text-[12.5px] text-ink-2">Nothing on the calendar today.</span>
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {rows.map(v => {
            const job = jobs[v.job_id]
            const client = clients[job?.client_id]
            const dot = statusDot(v, job)
            const cleanerIds = v.cleaner_ids?.length ? v.cleaner_ids : job?.cleaner_ids
            const needsCleaner = dot.label === 'Needs a cleaner'
            const crew = (Array.isArray(cleanerIds) && cleanerIds.length > 0 && empName)
              ? cleanerIds.map(id => empName(id)).filter(Boolean).slice(0, 2).join(', ')
                + (cleanerIds.length > 2 ? ` +${cleanerIds.length - 2}` : '')
              : null
            const start = (v.start_time || '').slice(0, 5)
            return (
              <button key={v.id} onClick={() => navigate(`/jobs/${v.job_id || v.id}`)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2">
                <span className="w-11 shrink-0 text-[12px] font-semibold tabular-nums text-ink-2">{start || '—'}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot.cls}`} title={dot.label} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold leading-snug text-ink">
                    {job?.title || `Visit ${v.id}`}
                  </span>
                  {client?.name && (
                    <span className="block truncate text-[11.5px] leading-snug text-ink-3">{client.name}</span>
                  )}
                </span>
                {needsCleaner ? (
                  <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${STATUS_TEXT.attention} dark:text-amber-300`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" /> needs a cleaner
                  </span>
                ) : crew ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-3" title="Assigned">
                    <User className="h-3 w-3" /> <span className="max-w-[7rem] truncate">{crew}</span>
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </section>

    {/* Jobs with no date at all — a sibling block, not a row in Today, because
        they are the opposite of today: a date-bounded week query can never
        surface them. Shared with the Schedule page; `className=""` mounts it
        flush with the cards around it instead of inset for a calendar edge.
        No `onSchedule` here: picking the date is the job page's modal, and the
        row already links there. Renders nothing when the list is empty, and
        crew roles are served `[]` by the backend. */}
    {!loading && !loadError && (
      <NeedsDateStrip jobs={unscheduled} className="" />
    )}
    </>
  )
}
