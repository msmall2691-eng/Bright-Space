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
import { MapPin, KeyRound, ParkingCircle, LogOut, RefreshCw, CalendarDays, Clock, Car } from 'lucide-react'
import { get, post, patch, logout } from '../api'
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

function fmtClock(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }
  catch { return '' }
}

// One closed punch in the "Today's punches" recap, with an inline miles editor
// (parity with Connecteam, where miles are entered per job). Tapping the miles
// value opens a small number field that PATCHes the entry — the safety net for a
// clock-out where miles were skipped or fat-fingered.
function PunchRecap({ entry, onSaveMiles, busy = false }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(entry.miles == null ? '' : String(entry.miles))

  const save = async () => {
    const raw = val.trim()
    const miles = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(miles) || miles < 0) return
    await onSaveMiles(entry.id, miles)
    setEditing(false)
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="text-ink-2 tabular-nums">
        {fmtClock(entry.clock_in_at)}–{fmtClock(entry.clock_out_at)}
        <span className="text-ink-3"> · {entry.hours ?? 0}h</span>
      </span>
      {editing ? (
        <span className="flex items-center gap-1.5">
          <input
            type="number" inputMode="decimal" step="0.1" min="0" value={val} autoFocus
            onChange={e => setVal(e.target.value)}
            className="w-16 rounded-md border border-hairline bg-bg px-2 py-1 text-right tabular-nums text-ink"
          />
          <span className="text-ink-3">mi</span>
          <button onClick={save} disabled={busy}
            className="font-semibold text-emerald-600 disabled:opacity-60 px-1">Save</button>
        </span>
      ) : (
        <button
          onClick={() => { setVal(entry.miles == null ? '' : String(entry.miles)); setEditing(true) }}
          className="flex items-center gap-1 text-ink-3 hover:text-ink tabular-nums">
          <Car className="w-3.5 h-3.5" />
          {entry.miles != null ? `${entry.miles} mi` : 'Add miles'}
        </button>
      )}
    </div>
  )
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
  // Clock-out miles prompt: opening the sheet, and the miles typed into it.
  const [clockOutOpen, setClockOutOpen] = useState(false)
  const [milesInput, setMilesInput] = useState('')

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

  // Clock-out is a two-step: open the miles prompt, then confirm. Miles at
  // clock-out mirrors how the crew enter miles per job on Connecteam.
  const requestClockOut = useCallback(() => {
    setMilesInput(''); setActionError(null); setClockOutOpen(true)
  }, [])

  const confirmClockOut = useCallback(async () => {
    const raw = milesInput.trim()
    const miles = raw === '' ? null : Number(raw)
    if (miles !== null && (!Number.isFinite(miles) || miles < 0)) {
      setActionError('Enter miles as a number, or leave it blank.')
      return
    }
    setActionBusy(true); setActionError(null)
    try {
      // Omit miles entirely when blank so a no-drive punch stays untouched.
      await post('/api/crew/clock-out', miles === null ? {} : { miles })
      setClockOutOpen(false)
      await fetchDay(true)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not clock out') }
    finally { setActionBusy(false) }
  }, [milesInput, fetchDay])

  // Correct the miles on an already-closed punch (from the Today's punches list).
  const saveMiles = useCallback(async (entryId, miles) => {
    setActionBusy(true); setActionError(null)
    try {
      await patch(`/api/crew/entry/${entryId}/miles`, { miles })
      await fetchDay(true)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not save miles') }
    finally { setActionBusy(false) }
  }, [fetchDay])

  const longDate = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  const activeJob = active && data?.today?.find(j => j.id === active.job_id)
  const hoursToday = clock?.hours_today || 0
  const closedToday = (clock?.entries_today || []).filter(e => !e.open)

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
            <button onClick={requestClockOut} disabled={actionBusy}
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
                      onClockOut={requestClockOut}
                      busy={actionBusy}
                    />
                  ))}
                </div>
              )}
            </section>

            {closedToday.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">Today's punches</h2>
                <div className={`${SOFT} px-4`}>
                  <div className="divide-y divide-hairline">
                    {closedToday.map(e => (
                      <PunchRecap key={e.id} entry={e} busy={actionBusy} onSaveMiles={saveMiles} />
                    ))}
                  </div>
                </div>
              </section>
            )}

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

      {clockOutOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
          onClick={() => { if (!actionBusy) setClockOutOpen(false) }}>
          <div
            className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div>
              <div className="text-base font-bold text-ink">Clock out</div>
              {activeJob && (
                <div className="text-[13px] text-ink-3 mt-0.5 truncate">
                  {activeJob.property_name || activeJob.title}
                </div>
              )}
            </div>
            <label className="block">
              <span className="text-[13px] font-medium text-ink-2 flex items-center gap-1.5">
                <Car className="w-4 h-4 text-ink-3" /> Miles driven for this job
              </span>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="number" inputMode="decimal" step="0.1" min="0" value={milesInput} autoFocus
                  onChange={e => setMilesInput(e.target.value)}
                  placeholder="0"
                  className="flex-1 rounded-lg border border-hairline bg-bg px-3 py-2.5 text-ink tabular-nums text-right"
                />
                <span className="text-sm text-ink-3">miles</span>
              </div>
              <span className="text-[11px] text-ink-3 mt-1.5 block">
                Leave blank if you didn't drive for this job.
              </span>
            </label>
            {actionError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setClockOutOpen(false)} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                Cancel
              </button>
              <button onClick={confirmClockOut} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
                {actionBusy ? 'Clocking out…' : 'Clock out'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
