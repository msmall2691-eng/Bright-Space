import { useMemo } from 'react'
import { ArrowRight, RefreshCw, User } from 'lucide-react'
import { useScheduleData } from '../../hooks/useScheduleData'
import { todayYMD } from '../../utils/format'

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
 */
function statusDot(v, job) {
  const cleanerIds = v.cleaner_ids?.length ? v.cleaner_ids : job?.cleaner_ids
  if (v.status === 'completed') return { cls: 'bg-emerald-500', label: 'Done' }
  if (v.status === 'cancelled') return { cls: 'bg-ink-3', label: 'Cancelled' }
  if (Array.isArray(cleanerIds) && cleanerIds.length === 0) return { cls: 'bg-amber-500', label: 'Needs a cleaner' }
  return { cls: 'bg-indigo-500', label: 'Scheduled' }
}

export default function HomeToday({ navigate }) {
  const { visits, jobs, clients, loading, loadError, refresh, empName } =
    useScheduleData(new Date(), 'week', { pollMs: 180000 })

  const today = todayYMD()
  const rows = useMemo(() => {
    const list = (visits || []).filter(v => (v.scheduled_date || jobs[v.job_id]?.scheduled_date) === today)
    return list.sort((a, b) => (a.start_time || '99').localeCompare(b.start_time || '99'))
  }, [visits, jobs, today])

  return (
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

      {loading ? (
        <div className="divide-y divide-hairline">
          {[0, 1, 2].map(i => <div key={i} className="h-11 animate-pulse bg-bg-2/40" />)}
        </div>
      ) : loadError ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3 text-[12.5px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">Couldn't load today's schedule.</span>
          <button onClick={refresh}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-link hover:text-link">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
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
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" /> needs a cleaner
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
  )
}
