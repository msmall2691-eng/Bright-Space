/**
 * My Day — the crew-facing landing page for role="cleaner" logins.
 *
 * Deliberately narrow: a cleaner sees only the jobs already assigned to
 * their crew ID (GET /api/crew/my-day), nothing else in the CRM. No
 * navigation chrome beyond logout — this is meant to be opened once on a
 * phone at the start of a shift, not browsed.
 *
 * Phase 1 (native crew directory): read-only. No clock-in yet — this page
 * is the "can a cleaner see their day without Connecteam" step; clock-in
 * with GPS + offline queue is the next phase, once this is trusted.
 */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, KeyRound, ParkingCircle, LogOut, RefreshCw, CalendarDays } from 'lucide-react'
import { get, logout } from '../api'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'

const SOFT = 'bg-panel rounded-xl border border-hairline shadow-glass-sm'

function fmtTimeRange(start, end) {
  if (!start && !end) return ''
  if (start && end) return `${start} – ${end}`
  return start || end
}

function JobCard({ job }) {
  const isTurnover = job.job_type === 'str_turnover'
  return (
    <div className={`${SOFT} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-bold text-ink tabular-nums">
            {fmtTimeRange(job.start_time, job.end_time) || 'Time TBD'}
          </div>
          <div className="text-sm font-semibold text-ink mt-0.5 truncate">
            {job.property_name || job.title}
          </div>
          {job.address && (
            <div className="text-xs text-ink-3 mt-0.5 flex items-center gap-1">
              <MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{job.address}</span>
            </div>
          )}
        </div>
        {isTurnover && (
          <span className="shrink-0 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            Turnover
          </span>
        )}
      </div>

      {job.turnover_line && (
        <div className="mt-3 rounded-lg bg-bg border border-hairline px-3 py-2 text-[13px] text-ink-2">
          {job.turnover_line}
        </div>
      )}

      {(job.access_notes || job.parking_notes || job.house_code) && (
        <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
          {job.house_code && !job.turnover_line?.includes(job.house_code) && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> Code {job.house_code}
            </div>
          )}
          {job.access_notes && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.access_notes}
            </div>
          )}
          {job.parking_notes && (
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <ParkingCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" /> {job.parking_notes}
            </div>
          )}
        </div>
      )}

      {job.crew_size > 1 && (
        <div className="mt-2 text-[11px] text-ink-3">{job.crew_size} on this job</div>
      )}
    </div>
  )
}

export default function MyDay() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setError(null)
    get('/api/crew/my-day')
      .then(setData)
      .catch(e => setError(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const longDate = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-10 bg-panel border-b border-hairline px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-ink">My Day</div>
          <div className="text-[12px] text-ink-3">{longDate}</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={load} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={logout} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Log out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="px-4 py-4 max-w-lg mx-auto space-y-5">
        {loading && (
          <div className="space-y-3">
            {[0, 1].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        )}

        {!loading && error && (
          error.status === 400 ? (
            <ErrorState
              title="Not set up yet"
              description={error.detail || error.message}
              compact
            />
          ) : (
            <ErrorState onRetry={load} compact />
          )
        )}

        {!loading && !error && data && (
          <>
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">Today</h2>
              {data.today.length === 0 ? (
                <EmptyState icon={CalendarDays} title="Nothing scheduled today" compact />
              ) : (
                <div className="space-y-3">
                  {data.today.map(j => <JobCard key={j.id} job={j} />)}
                </div>
              )}
            </section>

            {data.upcoming.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">Coming up</h2>
                <div className="space-y-3">
                  {data.upcoming.map(j => <JobCard key={j.id} job={j} />)}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
