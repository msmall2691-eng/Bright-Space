/**
 * My Day — the crew-facing landing page for role="cleaner" logins.
 *
 * Deliberately narrow: a cleaner sees only the jobs already assigned to their
 * crew ID (GET /api/crew/my-day), nothing else in the CRM. No navigation chrome
 * beyond logout — meant to be opened on a phone at the start of a shift.
 *
 * Phase 1: read-only job list. Phase 2a (this file): a native time clock —
 * Clock in / Clock out per job, a live "on the clock" bar, and hours today.
 * The clock is recorded natively but is NOT wired into payroll yet (payroll
 * still reads Connecteam); it exists to prove the clock works and to build up
 * hours to reconcile against Connecteam before any cutover.
 */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, KeyRound, ParkingCircle, LogOut, RefreshCw, CalendarDays, Clock } from 'lucide-react'
import { get, post, logout } from '../api'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'

const SOFT = 'bg-panel rounded-xl border border-hairline shadow-glass-sm'

function fmtTimeRange(start, end) {
  if (!start && !end) return ''
  if (start && end) return `${start} – ${end}`
  return start || end
}

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Best-effort browser geolocation for clock-in. Resolves null (never rejects)
// if the device has no geolocation, denies permission, or times out — a punch
// is never blocked on location.
function getPosition() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  })
}

function JobCard({ job, clockable = false, activeEntry = null, onClockIn, onClockOut, busy = false }) {
  const isTurnover = job.job_type === 'str_turnover'
  const isActiveJob = clockable && activeEntry && activeEntry.job_id === job.id
  const someoneElseActive = clockable && activeEntry && activeEntry.job_id !== job.id
  return (
    <div className={`${SOFT} p-4 ${isActiveJob ? 'ring-2 ring-emerald-500/60' : ''}`}>
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

      {clockable && (
        <div className="mt-3 border-t border-hairline pt-3">
          {isActiveJob ? (
            <button onClick={onClockOut} disabled={busy}
              className="w-full text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock out
            </button>
          ) : someoneElseActive ? (
            <button disabled title="Clock out of your current job first"
              className="w-full text-[13px] font-medium bg-panel border border-hairline text-ink-3 py-2 rounded-lg cursor-not-allowed">
              Clock in
            </button>
          ) : (
            <button onClick={onClockIn} disabled={busy}
              className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock in
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function MyDay() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [now, setNow] = useState(() => new Date())

  const fetchDay = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null) }
    return get('/api/crew/my-day')
      .then(setData)
      .catch(e => { if (!silent) setError(e) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [])

  useEffect(() => { fetchDay() }, [fetchDay])

  const clock = data?.clock
  const active = clock?.active || null

  // Tick the "on the clock" elapsed display while a punch is open.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [active])

  const clockIn = useCallback(async (jobId) => {
    setActionBusy(true); setActionError(null)
    try {
      const loc = await getPosition()   // best-effort; null if denied/unavailable
      await post('/api/crew/clock-in', { job_id: jobId ?? null, ...(loc || {}) })
      await fetchDay(true)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not clock in') }
    finally { setActionBusy(false) }
  }, [fetchDay])

  const clockOut = useCallback(async () => {
    setActionBusy(true); setActionError(null)
    try { await post('/api/crew/clock-out', {}); await fetchDay(true) }
    catch (e) { setActionError(e.detail || e.message || 'Could not clock out') }
    finally { setActionBusy(false) }
  }, [fetchDay])

  const longDate = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  const activeJob = active && data?.today?.find(j => j.id === active.job_id)
  const hoursToday = clock?.hours_today || 0

  return (
    <div className="min-h-screen bg-bg">
      <div className="sticky top-0 z-10">
        <header className="bg-panel border-b border-hairline px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-ink">My Day</div>
            <div className="text-[12px] text-ink-3">{longDate}</div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => fetchDay()} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={logout} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {active && (
          <div className="bg-emerald-600 text-white px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Clock className="w-4 h-4 shrink-0" />
              <div className="min-w-0 leading-tight">
                <div className="text-[13px] font-semibold truncate">
                  On the clock{activeJob ? ` · ${activeJob.property_name || activeJob.title}` : ''}
                </div>
                <div className="text-[11px] opacity-90 tabular-nums flex items-center gap-1">
                  {fmtDuration(now - new Date(active.clock_in_at))}
                  {active.has_location && (
                    <span className="inline-flex items-center gap-0.5 opacity-90">
                      <span className="opacity-60">·</span><MapPin className="w-3 h-3" /> located
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={clockOut} disabled={actionBusy}
              className="shrink-0 text-[13px] font-semibold bg-white/15 hover:bg-white/25 disabled:opacity-60 px-3 py-1.5 rounded-lg transition-colors">
              Clock out
            </button>
          </div>
        )}
      </div>

      <div className="px-4 py-4 max-w-lg mx-auto space-y-5">
        {actionError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {actionError}
          </div>
        )}

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
            <ErrorState onRetry={() => fetchDay()} compact />
          )
        )}

        {!loading && !error && data && (
          <>
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Today</h2>
                {hoursToday > 0 && (
                  <span className="text-[11px] text-ink-3 tabular-nums">{hoursToday}h logged today</span>
                )}
              </div>
              {data.today.length === 0 ? (
                <EmptyState icon={CalendarDays} title="Nothing scheduled today" compact />
              ) : (
                <div className="space-y-3">
                  {data.today.map(j => (
                    <JobCard
                      key={j.id}
                      job={j}
                      clockable
                      activeEntry={active}
                      onClockIn={() => clockIn(j.id)}
                      onClockOut={clockOut}
                      busy={actionBusy}
                    />
                  ))}
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
