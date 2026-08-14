/**
 * My Day — the crew-facing landing page for role="cleaner" logins.
 *
 * Deliberately narrow: a cleaner sees only the jobs already assigned to their
 * crew ID (GET /api/crew/my-day), nothing else in the CRM. No navigation chrome
 * beyond logout — meant to be opened on a phone at the start of a shift.
 *
 * Phase 1: read-only job list. Phase 2a (this file): a native time clock —
 * Clock in / Clock out per job, a live "on the clock" bar, and hours today.
 * The clock is what Payroll reads — the crew works fully native now.
 */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, KeyRound, ParkingCircle, LogOut, RefreshCw, CalendarDays, Clock, Car, DollarSign, ChevronDown, Navigation, CheckCircle2, Camera, Users, Phone, ClipboardList, CalendarRange, CircleUserRound, Sun, Sparkles, BookOpen } from 'lucide-react'
import { get, post, patch, logout } from '../api'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'
import JobPhotoSheet from '../components/crew/JobPhotoSheet'
import CrewProfile from '../components/crew/CrewProfile'
import CrewAvailability from '../components/crew/CrewAvailability'
import CrewLearn from '../components/crew/CrewLearn'
import CrewMonth from '../components/crew/CrewMonth'
import CrewCalendarSync from '../components/crew/CrewCalendarSync'
import CrewTimeOff from '../components/crew/CrewTimeOff'
import CrewMessagesCard from '../components/crew/CrewMessages'

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

/** Directions deep-link for the phone's native maps app. iOS intercepts
 *  maps.apple.com into Apple Maps; everything else gets the Google Maps
 *  universal directions URL (opens the app on Android, the site on desktop). */
function mapsUrl(address) {
  const q = encodeURIComponent(address)
  const ios = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)
  return ios
    ? `https://maps.apple.com/?daddr=${q}`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}`
}

// One closed punch in the "Today's punches" recap, with an inline miles editor
// (miles are entered per job). Tapping the miles value opens a small number
// field that PATCHes the entry — the safety net for a clock-out where miles
// were skipped or fat-fingered.
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

const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`

/** "This week" pay card: earned so far (from punches, same math as the office's
 *  Payroll page) + a prediction for the rest of the week from the jobs still
 *  assigned. Collapsed to the two headline numbers; expands to the per-job
 *  breakdown so a cleaner can see where the prediction comes from. */
function WeekPayCard({ week }) {
  const [open, setOpen] = useState(false)
  if (!week) return null
  const upcoming = week.upcoming || []
  return (
    <section>
      <div className="bg-panel border border-hairline rounded-xl overflow-hidden">
        <button onClick={() => setOpen(o => !o)} className="w-full px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="grid place-items-center w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 shrink-0">
              <DollarSign className="w-4 h-4" />
            </span>
            <div className="text-left leading-tight min-w-0">
              <div className="text-[13px] font-bold text-ink">This week</div>
              <div className="text-[11px] text-ink-3">
                Earned {fmtMoney(week.earned?.gross_pay)} · on track for {fmtMoney(week.predicted_week_total)}
              </div>
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 text-ink-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="px-4 pb-3 border-t border-hairline">
            <div className="flex items-center justify-between text-[12px] py-2 text-ink-2">
              <span>Earned so far ({week.earned?.hours || 0}h worked
                {week.earned?.miles ? `, ${week.earned.miles} mi` : ''})</span>
              <span className="font-semibold tabular-nums">{fmtMoney(week.earned?.gross_pay)}</span>
            </div>
            {upcoming.length > 0 && (
              <div className="divide-y divide-hairline border-t border-hairline">
                {upcoming.map(j => (
                  <div key={j.id} className="flex items-center justify-between gap-2 py-2 text-[12px]">
                    <div className="min-w-0">
                      <div className="text-ink-2 truncate">{j.property_name || j.title}</div>
                      <div className="text-[11px] text-ink-3">
                        {new Date(`${j.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}
                        {' · '}
                        {j.piece
                          ? (j.unpriced ? 'piece rate — not set yet' : 'piece rate')
                          : `${j.hours}h${j.bump ? ` · +$${j.bump}/hr` : ''}`}
                      </div>
                    </div>
                    <span className="font-semibold tabular-nums text-ink shrink-0">
                      {j.unpriced ? '—' : fmtMoney(j.predicted_pay)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between text-[12px] py-2 border-t border-hairline font-bold text-ink">
              <span>Week total (predicted)</span>
              <span className="tabular-nums">{fmtMoney(week.predicted_week_total)}</span>
            </div>
            <p className="text-[10px] text-ink-3 pb-1">
              Predictions use each job's scheduled length and your pay rates; the final number
              comes from your actual clocked hours.
            </p>
          </div>
        )}
      </div>
    </section>
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

/** Read-only view of the property's cleaning checklist, collapsed behind a
 *  task count. Working the checklist stays part of completion, not this list. */
function ChecklistBlock({ template }) {
  const [open, setOpen] = useState(false)
  const areas = Array.isArray(template) ? template : []
  const total = areas.reduce((n, a) => n + (a.tasks?.length || 0), 0)
  if (!total) return null
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <ClipboardList className="w-3.5 h-3.5 text-ink-3" /> Checklist
          <span className="text-ink-3">· {total} tasks</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {areas.map((a, i) => (
            <div key={i}>
              <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">{a.area}</div>
              <ul className="mt-0.5 space-y-0.5">
                {(a.tasks || []).map((t, j) => (
                  <li key={j} className="text-[13px] text-ink-2 flex items-start gap-1.5">
                    <span className="mt-[7px] w-1 h-1 rounded-full bg-ink-3 shrink-0" /> {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Accept / Can't-make-it on an assigned job (crew app Phase 2). An answer is
 *  a status the office sees — declining never takes the job off this list
 *  (the office decides the reassignment). Change is always allowed. */
function RespondRow({ job, onRespond, onDecline, busy }) {
  const [changing, setChanging] = useState(false)
  const r = job.my_response
  if (!r || changing) {
    return (
      <div className="mt-3 rounded-xl border border-blue-300/60 bg-blue-500/5 p-2.5">
        <div className="text-[11px] font-semibold text-ink-2 mb-1.5">Can you make this job?</div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => { setChanging(false); onRespond('accepted') }} disabled={busy}
            className="text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Accept
          </button>
          <button onClick={() => { setChanging(false); onDecline() }} disabled={busy}
            className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors">
            Can't make it
          </button>
        </div>
      </div>
    )
  }
  const accepted = r.response === 'accepted'
  return (
    <div className={`mt-3 rounded-lg border px-3 py-2 text-[12px] flex items-center justify-between gap-2 ${
      accepted
        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
        : 'bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300'}`}>
      <span className="min-w-0">
        {accepted ? '✓ You accepted' : 'You declined — the office knows'}
        {!accepted && r.reason && <span className="italic"> · “{r.reason}”</span>}
      </span>
      <button onClick={() => setChanging(true)} disabled={busy}
        className="shrink-0 font-semibold underline underline-offset-2 opacity-80 hover:opacity-100">
        Change
      </button>
    </div>
  )
}

/** The personal top-of-Today line: name, job count, and (fail-soft) the
 *  weather — the "should I bring a rain jacket" answer before the drive. */
function GreetingHero({ firstName, jobCount }) {
  const [wx, setWx] = useState(null)
  useEffect(() => {
    let cancelled = false
    get('/api/crew/weather')
      .then(d => { if (!cancelled && d?.available) setWx(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const h = new Date().getHours()
  const timeOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  return (
    <div className="mb-1">
      <div className="text-[17px] font-bold text-ink">
        Good {timeOfDay}{firstName ? `, ${firstName}` : ''}
        {timeOfDay === 'morning' ? ' ☀️' : ''}
      </div>
      <div className="text-[12px] text-ink-3">
        {jobCount === 0 ? 'Nothing on the books today.'
          : `${jobCount} job${jobCount > 1 ? 's' : ''} today.`}
        {wx && ` ${wx.temp_f}° now, high ${wx.high_f}°${wx.summary ? `, ${wx.summary}` : ''}${wx.precip_chance >= 40 ? ` — ${wx.precip_chance}% chance of rain` : ''}.`}
      </div>
    </div>
  )
}

function JobCard({ job, clockable = false, activeEntry = null, onClockIn, onClockOut, onMarkDone, onPhotos, onRespond, onDecline, onClaim, onTextClient, busy = false }) {
  const isTurnover = job.job_type === 'str_turnover'
  const done = job.status === 'completed'
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
            /* Tap → the phone's maps app with directions. Generous hit area on
               purpose: this is the most-used tap on the page from a car. */
            <a href={mapsUrl(job.address)} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-600 dark:text-blue-400 mt-1 -mb-1 py-1 flex items-center gap-1 active:opacity-60">
              <MapPin className="w-3 h-3 shrink-0" />
              <span className="truncate underline decoration-blue-400/40 underline-offset-2">{job.address}</span>
              <Navigation className="w-3 h-3 shrink-0 opacity-70" />
            </a>
          )}
        </div>
        {done ? (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            <CheckCircle2 className="w-3 h-3" /> Done
          </span>
        ) : isTurnover && (
          <span className="shrink-0 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            Turnover
          </span>
        )}
      </div>

      {/* The unanswered ask lives at the TOP of the card, not buried under
          notes/checklist blocks (owner: "I don't see it to accept"). Once
          answered it collapses to the small chip, still up here. */}
      {!done && onRespond && (
        <RespondRow job={job} onRespond={onRespond} onDecline={onDecline} busy={busy} />
      )}

      {(job.client_name || (job.teammates && job.teammates.length > 0)) && (
        <div className="mt-2 space-y-1">
          {job.client_name && (
            <div className="text-[13px] text-ink-2 flex items-center gap-1.5 flex-wrap">
              <span className="text-ink-3">For</span> {job.client_name}
              {job.can_text_client && !done && onTextClient && (
                /* No raw numbers on crew phones (owner's updated call):
                   texts go out structured, from the business line, logged
                   where the office reads them. */
                <button onClick={onTextClient}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 active:opacity-60">
                  <Phone className="w-3 h-3" /> Text client
                </button>
              )}
            </div>
          )}
          {job.teammates && job.teammates.length > 0 && (
            <div className="text-[13px] text-ink-2 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-ink-3 shrink-0" />
              With {job.teammates.join(', ')}
            </div>
          )}
        </div>
      )}

      {job.turnover_line && (
        <div className="mt-3 rounded-lg bg-bg border border-hairline px-3 py-2 text-[13px] text-ink-2">
          {job.turnover_line}
        </div>
      )}

      {!job.open && !job.access_notes && !job.house_code && !done && (
        /* Empty ≠ broken: tell them BEFORE they drive that no code is on
           file, so "how do I get in" gets asked from the driveway at home,
           not the doorstep. */
        <div className="mt-2 text-[11px] text-ink-3 flex items-start gap-1.5">
          <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          No access info on file — ask the office if you need a code.
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

      {job.notes && (
        /* What the office wrote on the job — the "dog in the yard" tier.
           Was silently missing from crew cards until Aug 2026. */
        <div className="mt-3 rounded-lg bg-blue-500/5 border border-blue-500/15 px-3 py-2 text-[12px] text-ink-2 whitespace-pre-wrap">
          <span className="font-semibold text-ink">From the office: </span>{job.notes}
        </div>
      )}

      <ChecklistBlock template={job.checklist_template} />

      {done && job.completion_note && (
        <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[12px] text-ink-2">
          Your note: “{job.completion_note}”
        </div>
      )}

      {onClaim && (
        /* Open-jobs board (Phase 3): first tap wins server-side; access
           details and the customer's number unlock once it's theirs. */
        <div className="mt-3 border-t border-hairline pt-3">
          <button onClick={onClaim} disabled={busy}
            className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <Sparkles className="w-4 h-4" /> Claim this job
          </button>
          <p className="text-[10px] text-ink-3 mt-1.5 text-center">
            First come, first served{job.teammates?.length ? ` · you'd join ${job.teammates.join(', ')}` : ''}
          </p>
        </div>
      )}

      {clockable && !done && (
        <div className="mt-3 border-t border-hairline pt-3 grid grid-cols-2 gap-2">
          {isActiveJob ? (
            <button onClick={onClockOut} disabled={busy}
              className="text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock out
            </button>
          ) : someoneElseActive ? (
            <button disabled title="Clock out of your current job first"
              className="text-[13px] font-medium bg-panel border border-hairline text-ink-3 py-2 rounded-lg cursor-not-allowed">
              Clock in
            </button>
          ) : (
            <button onClick={onClockIn} disabled={busy}
              className="text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
              Clock in
            </button>
          )}
          <button onClick={onMarkDone} disabled={busy}
            className="text-[13px] font-semibold bg-panel border border-hairline text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Mark done
          </button>
        </div>
      )}

      {clockable && done && isActiveJob && (
        /* Marked done but the punch is still open — keep clock-out reachable
           right on the card (the green header bar has it too). */
        <div className="mt-3 border-t border-hairline pt-3">
          <button onClick={onClockOut} disabled={busy}
            className="w-full text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2 rounded-lg transition-colors">
            Clock out
          </button>
        </div>
      )}

      {onPhotos && (
        /* Photos stay reachable after Mark done on purpose — "after" shots are
           usually taken on the way out the door. */
        <button onClick={onPhotos} disabled={busy}
          className="mt-2 w-full text-[12px] font-medium text-ink-3 hover:text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 border border-dashed border-hairline">
          <Camera className="w-3.5 h-3.5" /> Photos
        </button>
      )}
    </div>
  )
}

/** Upcoming jobs grouped by day with a friendly header — the Schedule tab. */
function groupByDate(jobs) {
  const groups = []
  for (const j of jobs) {
    const last = groups[groups.length - 1]
    if (last && last.date === j.scheduled_date) last.jobs.push(j)
    else groups.push({ date: j.scheduled_date, jobs: [j] })
  }
  return groups
}

function dayLabel(iso) {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00:00`)
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const diffDays = Math.round((d - today) / 86400000)
  if (diffDays === 1) return 'Tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

const TABS = [
  { key: 'today', label: 'Today', icon: Sun },
  { key: 'schedule', label: 'Schedule', icon: CalendarRange },
  { key: 'learn', label: 'Learn', icon: BookOpen },
  { key: 'me', label: 'Me', icon: CircleUserRound },
]

function CrewTabBar({ tab, setTab }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-panel/95 backdrop-blur border-t border-hairline"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-lg mx-auto grid grid-cols-4">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`py-2.5 flex flex-col items-center gap-0.5 text-[11px] font-semibold transition-colors ${
              tab === key ? 'text-blue-600 dark:text-blue-400' : 'text-ink-3 hover:text-ink-2'}`}>
            <Icon className="w-5 h-5" strokeWidth={tab === key ? 2.4 : 2} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  )
}

export default function MyDay() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('today')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [now, setNow] = useState(() => new Date())
  // Clock-out miles prompt: opening the sheet, and the miles typed into it.
  const [clockOutOpen, setClockOutOpen] = useState(false)
  const [milesInput, setMilesInput] = useState('')
  // Mark-done sheet: the job being completed (null = closed) + optional note.
  const [markDoneJob, setMarkDoneJob] = useState(null)
  const [doneNote, setDoneNote] = useState('')
  // Photo sheet: the job whose photos are open (null = closed).
  const [photoJob, setPhotoJob] = useState(null)
  // Decline sheet: the job being declined (null = closed) + optional reason.
  const [declineJob, setDeclineJob] = useState(null)
  const [declineReason, setDeclineReason] = useState('')
  // Claim confirm sheet: the open job being claimed (null = closed).
  const [claimJob, setClaimJob] = useState(null)
  // Non-null = showing the offline cached copy saved at this timestamp.
  const [staleAt, setStaleAt] = useState(null)
  // Schedule tab layout: the 2-week list or the month grid.
  const [schedView, setSchedView] = useState('list')
  // Structured client-text sheet: the job being texted about (null = closed).
  const [textJob, setTextJob] = useState(null)
  const [textNote, setTextNote] = useState('')
  const [textSent, setTextSent] = useState(null)   // backend's sent preview

  const [weekPay, setWeekPay] = useState(null)

  const fetchDay = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null) }
    // Week pay rides along on every refresh (clocking out changes "earned so
    // far") but is best-effort — the day view never blocks on it.
    get('/api/crew/my-week').then(setWeekPay).catch(() => {})
    // days=14 (the endpoint's max) so the Schedule tab shows two weeks out.
    return get('/api/crew/my-day?days=14')
      .then(d => {
        setData(d); setStaleAt(null)
        // Offline resilience: keep the last good day on the device, so one
        // bar of service in a driveway still shows the schedule + door
        // codes (which matter most exactly where signal is worst).
        try {
          localStorage.setItem('bb_myday_cache',
            JSON.stringify({ data: d, savedAt: Date.now() }))
        } catch { /* storage full/blocked — cache is a bonus, not a need */ }
      })
      .catch(e => {
        // Server unreachable → fall back to the cached copy instead of a
        // dead error screen. Actions still fail loudly; reading works.
        try {
          const c = JSON.parse(localStorage.getItem('bb_myday_cache') || 'null')
          if (c?.data) {
            setData(c.data); setStaleAt(c.savedAt); setError(null)
            return
          }
        } catch { /* corrupt cache — fall through to the error */ }
        if (!silent) setError(e)
      })
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

  // Clock-out is a two-step: open the miles prompt, then confirm. Miles are
  // entered per job at clock-out so mileage lands on the right shift.
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

  // Mark done is a two-step like clock-out: open the sheet (optional note),
  // then confirm. POSTs to the crew-scoped completion endpoint — assignment
  // is verified server-side; the office sees the note on the job + timeline.
  const requestMarkDone = useCallback((job) => {
    setDoneNote(''); setActionError(null); setMarkDoneJob(job)
  }, [])

  const confirmMarkDone = useCallback(async () => {
    if (!markDoneJob) return
    setActionBusy(true); setActionError(null)
    try {
      const note = doneNote.trim()
      await post(`/api/crew/jobs/${markDoneJob.id}/complete`, note ? { note } : {})
      setMarkDoneJob(null)
      await fetchDay(true)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not mark the job done') }
    finally { setActionBusy(false) }
  }, [markDoneJob, doneNote, fetchDay])

  // Accept is one tap; declining opens a sheet for the optional reason.
  // Either way the answer is a status — the job stays on the list (the
  // office decides any reassignment).
  const respond = useCallback(async (job, response, reason) => {
    setActionBusy(true); setActionError(null)
    try {
      await post(`/api/crew/jobs/${job.id}/respond`,
        reason ? { response, reason } : { response })
      setDeclineJob(null)
      await fetchDay(true)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not send your answer') }
    finally { setActionBusy(false) }
  }, [fetchDay])

  const requestDecline = useCallback((job) => {
    setDeclineReason(''); setActionError(null); setDeclineJob(job)
  }, [])

  const sendClientText = useCallback(async (job, template, note) => {
    setActionBusy(true); setActionError(null)
    try {
      const r = await post(`/api/crew/jobs/${job.id}/notify-client`,
        note ? { template, note } : { template })
      setTextSent(r.preview || 'Sent!')
    } catch (e) {
      setActionError(e.detail || e.message || 'Could not send')
    } finally {
      setActionBusy(false)
    }
  }, [])

  // Claim an open job — the confirm sheet's Claim button. First tap wins is
  // enforced server-side; a 409 here means somebody else got it, so refresh
  // the board rather than leaving a stale offer on screen.
  const confirmClaim = useCallback(async () => {
    if (!claimJob) return
    setActionBusy(true); setActionError(null)
    try {
      await post(`/api/crew/jobs/${claimJob.id}/claim`)
      setClaimJob(null)
      await fetchDay(true)
    }
    catch (e) {
      setActionError(e.detail || e.message || 'Could not claim the job')
      if (e.status === 409) { setClaimJob(null); await fetchDay(true) }
    }
    finally { setActionBusy(false) }
  }, [claimJob, fetchDay])

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
            <div className="text-sm font-bold text-ink">
              {tab === 'schedule' ? 'My Schedule' : tab === 'me' ? 'Me' : tab === 'learn' ? 'Learn' : 'My Day'}
            </div>
            <div className="text-[12px] text-ink-3">{longDate}</div>
          </div>
          <button onClick={() => fetchDay()} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </header>

        {staleAt && (
          /* Offline fallback in effect: reading works from the cached copy;
             buttons will fail until service returns. Tapping retries. */
          <button onClick={() => fetchDay()}
            className="w-full bg-amber-500/15 border-b border-amber-500/30 text-amber-800 dark:text-amber-300 px-4 py-2 text-[12px] font-medium text-left">
            No connection — showing your schedule saved at{' '}
            {new Date(staleAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
            Tap to retry.
          </button>
        )}

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

      <div className="px-4 py-4 max-w-lg mx-auto space-y-5 pb-24">
        {actionError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {actionError}
          </div>
        )}

        {tab !== 'me' && loading && (
          <div className="space-y-3">
            {[0, 1].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        )}

        {tab !== 'me' && !loading && error && (
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

        {tab === 'today' && !loading && !error && data && (
          <>
            <GreetingHero firstName={data.first_name} jobCount={(data.today || []).length} />

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
                      onMarkDone={() => requestMarkDone(j)}
                      onPhotos={() => setPhotoJob(j)}
                      onRespond={(resp) => respond(j, resp)}
                      onDecline={() => requestDecline(j)}
                      onTextClient={() => { setTextNote(''); setTextSent(null); setActionError(null); setTextJob(j) }}
                      busy={actionBusy}
                    />
                  ))}
                </div>
              )}
            </section>

            {(data.open_jobs || []).filter(j => j.scheduled_date === data.as_of).length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" /> Up for grabs today
                </h2>
                <div className="space-y-3">
                  {(data.open_jobs || []).filter(j => j.scheduled_date === data.as_of).map(j => (
                    <JobCard key={j.id} job={j} onClaim={() => { setActionError(null); setClaimJob(j) }} busy={actionBusy} />
                  ))}
                </div>
              </section>
            )}

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
          </>
        )}

        {tab === 'schedule' && (
          <div className="flex gap-1.5 mb-1">
            {[['list', 'Next 2 weeks'], ['month', 'Month']].map(([v, l]) => (
              <button key={v} onClick={() => setSchedView(v)} aria-pressed={schedView === v}
                className={`text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                  schedView === v ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-panel border-hairline text-ink-2'}`}>
                {l}
              </button>
            ))}
          </div>
        )}

        {tab === 'schedule' && schedView === 'month' && <CrewMonth />}

        {tab === 'schedule' && schedView === 'list' && !loading && !error && data && (data.open_jobs || []).length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" /> Up for grabs
            </h2>
            <div className="space-y-3">
              {(data.open_jobs || []).map(j => (
                <JobCard key={j.id} job={j} onClaim={() => { setActionError(null); setClaimJob(j) }} busy={actionBusy} />
              ))}
            </div>
          </section>
        )}

        {tab === 'schedule' && schedView === 'list' && !loading && !error && data && (
          data.upcoming.length === 0 ? (
            (data.open_jobs || []).length > 0 ? null :
            <EmptyState icon={CalendarRange} title="Nothing else scheduled yet"
              description="Jobs assigned to you over the next two weeks show up here." compact />
          ) : (
            groupByDate(data.upcoming).map(g => (
              <section key={g.date}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">
                  {dayLabel(g.date)}
                </h2>
                <div className="space-y-3">
                  {g.jobs.map(j => (
                    <JobCard key={j.id} job={j}
                      onRespond={(resp) => respond(j, resp)}
                      onDecline={() => requestDecline(j)}
                      onTextClient={() => { setTextNote(''); setTextSent(null); setActionError(null); setTextJob(j) }}
                      busy={actionBusy} />
                  ))}
                </div>
              </section>
            ))
          )
        )}

        {tab === 'learn' && <CrewLearn />}

        {tab === 'me' && (
          <>
            <CrewProfile />
            <CrewMessagesCard />
            <CrewTimeOff />
            <CrewAvailability />
            <CrewCalendarSync />
            <WeekPayCard week={weekPay} />
            <button onClick={logout}
              className="w-full text-[13px] font-semibold bg-panel border border-hairline text-red-600 dark:text-red-400 py-2.5 rounded-lg hover:bg-bg-2 transition-colors inline-flex items-center justify-center gap-1.5">
              <LogOut className="w-4 h-4" /> Log out
            </button>
          </>
        )}
      </div>

      <CrewTabBar tab={tab} setTab={setTab} />

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

      {photoJob && (
        <JobPhotoSheet job={photoJob} onClose={() => setPhotoJob(null)} />
      )}

      {textJob && (() => {
        const tomorrow = (() => {
          const d = new Date(`${data?.as_of}T12:00`); d.setDate(d.getDate() + 1)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        })()
        const canOnTheWay = textJob.scheduled_date === data?.as_of
        const canTomorrow = textJob.scheduled_date === tomorrow
        return (
          <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
            onClick={() => { if (!actionBusy) setTextJob(null) }}>
            <div className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-3"
              onClick={e => e.stopPropagation()}>
              <div>
                <div className="text-base font-bold text-ink">Text {textJob.client_name || 'the client'}</div>
                <div className="text-[11px] text-ink-3 mt-0.5">
                  Sent from the company number and logged for the office — their
                  number stays private.
                </div>
              </div>
              {textSent ? (
                <>
                  <div className="text-[12.5px] text-ink-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                    Sent ✓ &nbsp;“{textSent}”
                  </div>
                  <button onClick={() => setTextJob(null)}
                    className="w-full text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 transition-colors">
                    Done
                  </button>
                </>
              ) : (
                <>
                  {!canOnTheWay && !canTomorrow ? (
                    <p className="text-[12.5px] text-ink-3">
                      Texts unlock the day before ("see you tomorrow") and the
                      day of ("on the way").
                    </p>
                  ) : (
                    <>
                      <label className="block">
                        <span className="text-[12px] font-medium text-ink-2">Add a personal line (optional)</span>
                        <input value={textNote} maxLength={160}
                          onChange={e => setTextNote(e.target.value)}
                          placeholder="e.g. It's Sarah and Meg today!"
                          className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400" />
                      </label>
                      <div className="space-y-2">
                        {canOnTheWay && (
                          <button onClick={() => sendClientText(textJob, 'on_the_way', textNote.trim() || undefined)}
                            disabled={actionBusy}
                            className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
                            {actionBusy ? 'Sending…' : "🚗 We're on the way"}
                          </button>
                        )}
                        {canTomorrow && (
                          <button onClick={() => sendClientText(textJob, 'tomorrow', textNote.trim() || undefined)}
                            disabled={actionBusy}
                            className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
                            {actionBusy ? 'Sending…' : '👋 Looking forward to tomorrow'}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {actionError && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      {actionError}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })()}

      {claimJob && (
        <div
          className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
          onClick={() => { if (!actionBusy) setClaimJob(null) }}>
          <div
            className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div>
              <div className="text-base font-bold text-ink">Claim this job?</div>
              <div className="text-[13px] text-ink-3 mt-0.5 truncate">
                {claimJob.property_name || claimJob.title}
                {claimJob.scheduled_date ? ` · ${claimJob.scheduled_date === data?.as_of ? 'Today' : dayLabel(claimJob.scheduled_date)}` : ''}
                {claimJob.start_time ? ` · ${fmtTimeRange(claimJob.start_time, claimJob.end_time)}` : ''}
              </div>
            </div>
            <p className="text-[12px] text-ink-3">
              First come, first served — it's yours the moment you tap Claim, and the
              office gets notified. Address details unlock once it's on your list.
            </p>
            {actionError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setClaimJob(null)} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                Never mind
              </button>
              <button onClick={confirmClaim} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                {actionBusy ? 'Claiming…' : 'Claim it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {declineJob && (
        <div
          className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
          onClick={() => { if (!actionBusy) setDeclineJob(null) }}>
          <div
            className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div>
              <div className="text-base font-bold text-ink">Can't make it</div>
              <div className="text-[13px] text-ink-3 mt-0.5 truncate">
                {declineJob.property_name || declineJob.title}
                {declineJob.scheduled_date ? ` · ${dayLabel(declineJob.scheduled_date)}` : ''}
              </div>
            </div>
            <p className="text-[12px] text-ink-3">
              You'll stay on the job until the office reassigns it — they get
              notified right away.
            </p>
            <label className="block">
              <span className="text-[13px] font-medium text-ink-2">Why not? (optional)</span>
              <textarea
                value={declineReason} onChange={e => setDeclineReason(e.target.value)}
                rows={2} maxLength={2000} autoFocus
                placeholder="e.g. doctor's appointment, car trouble…"
                className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 resize-none"
              />
            </label>
            {actionError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setDeclineJob(null)} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                Never mind
              </button>
              <button onClick={() => respond(declineJob, 'declined', declineReason.trim() || undefined)}
                disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-amber-600 hover:bg-amber-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
                {actionBusy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {markDoneJob && (
        <div
          className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
          onClick={() => { if (!actionBusy) setMarkDoneJob(null) }}>
          <div
            className="w-full max-w-sm bg-panel rounded-2xl border border-hairline shadow-glass p-5 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div>
              <div className="text-base font-bold text-ink">Mark done</div>
              <div className="text-[13px] text-ink-3 mt-0.5 truncate">
                {markDoneJob.property_name || markDoneJob.title}
              </div>
            </div>
            {active && active.job_id === markDoneJob.id && (
              <div className="text-[12px] text-amber-800 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                You're still on the clock — remember to clock out when you leave.
              </div>
            )}
            <label className="block">
              <span className="text-[13px] font-medium text-ink-2">Anything for the office?</span>
              <textarea
                value={doneNote} onChange={e => setDoneNote(e.target.value)}
                rows={3} maxLength={2000} autoFocus
                placeholder="Optional — e.g. lockbox was empty, we're low on towels…"
                className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 resize-none"
              />
            </label>
            {actionError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {actionError}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setMarkDoneJob(null)} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-panel border border-hairline text-ink-2 py-2.5 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
                Cancel
              </button>
              <button onClick={confirmMarkDone} disabled={actionBusy}
                className="flex-1 text-[13px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                {actionBusy ? 'Saving…' : 'Mark done'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
