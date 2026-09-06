/**
 * My Day — the crew-facing landing page for role="cleaner" logins.
 *
 * Deliberately narrow: a cleaner sees only the jobs already assigned to their
 * crew ID (GET /api/crew/my-day), nothing else in the CRM. No navigation chrome
 * beyond logout — meant to be opened on a phone at the start of a shift.
 *
 * Tabs: Today, Schedule (2 weeks / month), Chat, Learn, Me.
 * The Me tab is a sectioned accordion (Work / Phone) — each row expands in
 * place and only fetches once opened, so opening Me costs one request (the
 * week-pay summary), not four.
 */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, LogOut, RefreshCw, CalendarDays, Clock, Car, DollarSign, CheckCircle2, CalendarRange, CircleUserRound, Sparkles, BookOpen, MessageSquare, Sun, CalendarClock, CalendarOff, Smartphone, CalendarPlus, ShieldCheck } from 'lucide-react'
import { get, post, patch, logout } from '../api'
import { toast } from '../utils/toastBus'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'
import JobPhotoSheet from '../components/crew/JobPhotoSheet'
import CrewProfile from '../components/crew/CrewProfile'
import CrewMyFile from '../components/crew/CrewMyFile'
import CrewMyRoutes from '../components/crew/CrewMyRoutes'
import CrewAvailability from '../components/crew/CrewAvailability'
import CrewLearn from '../components/crew/CrewLearn'
import CrewMonth from '../components/crew/CrewMonth'
import CrewCalendarSync from '../components/crew/CrewCalendarSync'
import CrewTimeOff from '../components/crew/CrewTimeOff'
import { CrewThread } from '../components/crew/CrewMessages'
import PropertySheet from '../components/crew/PropertySheet'
// The job card lives in its own file so every crew surface (Today list,
// schedule list, month tap-through sheet) renders the SAME details.
import JobCard, { fmtTimeRange } from '../components/crew/JobCard'
import CrewJobSheet from '../components/crew/CrewJobSheet'
import CrewSetupCard from '../components/crew/CrewSetupCard'
import { SOFT, CrewCard, SectionLabel, ErrorNote, SettingRow, Sheet, SheetActions } from '../components/crew/primitives'
// Photos captured on cellular wait on-device and send on WiFi — My Day owns
// flushing the queue (app open + connectivity changes) and the visible
// "waiting" line with the cleaner's Send-now override.
import { flushPhotoQueue, subscribeQueue } from '../components/crew/photoQueue'

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

const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`

/** "This week" pay breakdown — the body of the Me tab's This-week row.
 *  Earned so far (from punches, same math as the office's Payroll page) +
 *  a prediction for the rest of the week from the jobs still assigned. */
function WeekPayBreakdown({ week, onOpenJob }) {
  if (!week) return <Skeleton className="h-16 w-full rounded-lg" />
  const upcoming = week.upcoming || []
  return (
    <div>
      <div className="flex items-center justify-between text-[12px] py-2 text-ink-2">
        <span>Earned so far ({week.earned?.hours || 0}h worked
          {week.earned?.miles ? `, ${week.earned.miles} mi` : ''})</span>
        <span className="font-semibold tabular-nums">{fmtMoney(week.earned?.gross_pay)}</span>
      </div>
      {upcoming.length > 0 && (
        <div className="divide-y divide-hairline border-t border-hairline">
          {upcoming.map(j => (
            /* Every job row anywhere in the crew UI opens its details —
               this one included (the crew-only detail sheet). */
            <button key={j.id} onClick={() => onOpenJob?.(j.id)}
              className="w-full flex items-center justify-between gap-2 py-2 text-[12px] text-left active:opacity-60">
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
                <span className="text-blue-500 ml-1">›</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between text-[12px] py-2 border-t border-hairline font-bold text-ink">
        <span>Week total (predicted)</span>
        <span className="tabular-nums">{fmtMoney(week.predicted_week_total)}</span>
      </div>
      <p className="text-[10px] text-ink-3 pb-1">
        Predictions use each job's scheduled length and your pay rates; the final number
        is the amount you agreed for each job.
      </p>
    </div>
  )
}

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
  // Chat rides the bottom nav (owner: "chat more prominent") — one tap from
  // anywhere, with an unread badge fed by my-day's unread_messages count.
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'learn', label: 'Learn', icon: BookOpen },
  { key: 'me', label: 'Me', icon: CircleUserRound },
]

function CrewTabBar({ tab, setTab, chatUnread = 0 }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-panel/95 backdrop-blur border-t border-hairline"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-lg mx-auto grid grid-cols-5">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`py-2.5 flex flex-col items-center gap-0.5 text-[11px] font-semibold transition-colors ${
              tab === key ? 'text-blue-600 dark:text-blue-400' : 'text-ink-3 hover:text-ink-2'}`}>
            <Icon className="w-5 h-5" strokeWidth={tab === key ? 2.4 : 2} />
            <span className="inline-flex items-center gap-1">
              {label}
              {key === 'chat' && chatUnread > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden="true" />
                  <span className="text-[10px] font-bold text-ink tabular-nums">
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </span>
                </span>
              )}
            </span>
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
  // Marketplace pivot (migration 097): an open job is asked for, not taken.
  // Blank counter = "I'll take your posted rate" — the common case, so it
  // starts empty rather than pre-filled with a number to delete.
  const [claimRate, setClaimRate] = useState('')
  const [claimMessage, setClaimMessage] = useState('')
  // Non-null = showing the offline cached copy saved at this timestamp.
  const [staleAt, setStaleAt] = useState(null)
  // Schedule tab layout: the 2-week list or the month grid.
  const [schedView, setSchedView] = useState('list')
  // House photos & notes sheet: the job whose property is open (null = closed).
  const [houseJob, setHouseJob] = useState(null)
  // Crew job-detail sheet: tap any job row (e.g. the week-pay breakdown) and
  // the full card opens, fetched from the crew-only detail endpoint.
  const [sheetJobId, setSheetJobId] = useState(null)
  // Structured client-text sheet: the job being texted about (null = closed).
  const [textJob, setTextJob] = useState(null)
  const [textNote, setTextNote] = useState('')
  const [textSent, setTextSent] = useState(null)   // backend's sent preview

  const [weekPay, setWeekPay] = useState(null)
  // Photos waiting for WiFi (see components/crew/photoQueue.js).
  const [queuedPhotos, setQueuedPhotos] = useState(0)
  const [sendingQueued, setSendingQueued] = useState(false)

  useEffect(() => {
    const unsub = subscribeQueue(setQueuedPhotos)
    // Flush whatever is waiting: on open, when the browser comes back online,
    // and when the connection type changes (cellular → WiFi). flush() itself
    // refuses to run on cellular unless forced.
    flushPhotoQueue()
    const onChange = () => { flushPhotoQueue() }
    window.addEventListener('online', onChange)
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    conn?.addEventListener?.('change', onChange)
    return () => {
      unsub()
      window.removeEventListener('online', onChange)
      conn?.removeEventListener?.('change', onChange)
    }
  }, [])

  const sendQueuedNow = useCallback(async () => {
    setSendingQueued(true)
    try { await flushPhotoQueue({ force: true }) }
    finally { setSendingQueued(false) }
  }, [])

  const fetchDay = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null) }
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

  // Week pay loads when (and only when) the Me tab opens — it used to ride
  // every my-day refresh for a card nobody was looking at. Re-opening the
  // tab refreshes it.
  useEffect(() => {
    if (tab !== 'me') return undefined
    let cancelled = false
    get('/api/crew/my-week').then(d => { if (!cancelled) setWeekPay(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [tab])

  // Mark done is a two-step: open the sheet (optional note),
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

  // Ask for an open job (marketplace pivot, migration 097). This files a
  // REQUEST — it doesn't assign anything, so there's no race to lose. A 409
  // means the job stopped being open (someone was picked, or the office
  // pulled it), so refresh rather than leaving a dead offer on screen.
  const confirmClaim = useCallback(async () => {
    if (!claimJob) return
    setActionBusy(true); setActionError(null)
    const raw = String(claimRate).trim()
    try {
      const res = await post(`/api/crew/jobs/${claimJob.id}/claim`, {
        // Empty means "your price is fine" — send null, not 0, or the server
        // reads it as an offer to work for nothing.
        requested_rate: raw === '' ? null : Number(raw),
        message: claimMessage.trim() || null,
      })
      setClaimJob(null); setClaimRate(''); setClaimMessage('')
      // When the office has auto-approval on and nothing needed deciding, the
      // job is already theirs by the time this returns. Saying "we'll let you
      // know" then would be false, and the version of false that makes someone
      // ring the office to ask.
      toast.success(res?.auto_approved
        ? 'It’s yours — it’s on your schedule now.'
        : 'Request sent. The office will get back to you.')
      await fetchDay(true)
    }
    catch (e) {
      setActionError(e.detail || e.message || 'Could not send your request')
      if (e.status === 409) { setClaimJob(null); await fetchDay(true) }
    }
    finally { setActionBusy(false) }
  }, [claimJob, claimRate, claimMessage, fetchDay])

  // Correct the miles on an already-closed punch (from the Today's punches list).

  return (
    <div className="min-h-screen bg-bg">
      <div className="sticky top-0 z-10 safe-top bg-panel">
        <header className="bg-panel border-b border-hairline px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-ink">
              {tab === 'schedule' ? 'My Schedule' : tab === 'me' ? 'Me' : tab === 'learn' ? 'Learn' : tab === 'chat' ? 'Chat' : 'My Day'}
            </div>
            <div className="text-[12px] text-ink-3">{longDate}</div>
          </div>
          <button onClick={() => fetchDay()} className="p-2 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </header>

        {staleAt && (
          /* Offline fallback in effect: reading works from the cached copy;
             buttons will fail until service returns. Persistent (sticky,
             stays until a fetch succeeds) — quiet hairline-card treatment
             per the design language rather than a full-bleed colored bar. */
          <div className="flex items-center justify-between gap-2 border-b border-hairline bg-panel px-4 py-2">
            <span className="text-[12px] text-ink-2 flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              <span className="truncate">
                No connection — showing your schedule saved at{' '}
                {new Date(staleAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
              </span>
            </span>
            <button onClick={() => fetchDay()}
              className="shrink-0 min-h-8 text-[12px] font-medium text-ink-2 border border-hairline-2 rounded-md px-2.5 py-1 hover:bg-bg-2 transition-colors">
              Tap to retry
            </button>
          </div>
        )}
      </div>

      <div className="px-4 py-4 max-w-lg mx-auto space-y-5 pb-24">
        <ErrorNote>{actionError}</ErrorNote>

        {queuedPhotos > 0 && (
          /* Photos captured on cellular, waiting for WiFi. Quiet hairline
             card + amber dot; Send now is the cleaner's override. */
          <div className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-panel px-3 py-2">
            <span className="text-[12px] text-ink-2 flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              {queuedPhotos} photo{queuedPhotos > 1 ? 's' : ''} waiting for WiFi
            </span>
            <button onClick={sendQueuedNow} disabled={sendingQueued}
              className="shrink-0 min-h-9 text-[12px] font-medium text-ink-2 border border-hairline-2 rounded-md px-2.5 py-1 hover:bg-bg-2 disabled:opacity-60 transition-colors">
              {sendingQueued ? 'Sending…' : 'Send now'}
            </button>
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

            {(data.routes || []).some(r => r.status === 'offered') && (
              /* A standing offer is worth more than a shift and expires by
                 being ignored, so it leads rather than waiting behind a tab.
                 Dot + sentence, not a banner. */
              <button type="button"
                onClick={() => { setTab('schedule'); setSchedView('routes') }}
                className="w-full rounded-xl border border-hairline bg-panel px-4 py-3 text-left transition-colors hover:bg-bg-2">
                <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  You've been offered a route
                </span>
                <span className="mt-0.5 block text-[14px] font-medium text-ink">
                  {(data.routes || []).find(r => r.status === 'offered')?.name} — have a look
                </span>
              </button>
            )}


            <section>
              <div className="flex items-center justify-between mb-2">
                <SectionLabel>Today</SectionLabel>
              </div>
              {data.today.length === 0 ? (
                /* NOTHING ON TODAY MEANS SHOW THEM WORK, NOT AN EMPTY BOX.
                   A subcontractor with a clear day is the person most likely
                   to take something, and the board they'd take it from used to
                   be two taps away inside Schedule > list. Turno opens a
                   cleaner on work they can bid for; so does this now. The
                   empty state only stands when there is genuinely nothing to
                   offer. */
                (data.open_jobs || []).length > 0 ? (
                  <div className="space-y-3">
                    <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
                      <span className="h-1.5 w-1.5 rounded-full bg-violet-500" aria-hidden="true" />
                      Nothing booked today — here's what's up for grabs
                    </p>
                    {(data.open_jobs || []).map(j => (
                      <JobCard key={j.id} job={j} busy={actionBusy}
                        onClaim={() => { setActionError(null); setClaimRate(j.my_claim_request?.requested_rate ?? ''); setClaimMessage(j.my_claim_request?.message || ''); setClaimJob(j) }} />
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={CalendarDays} title="Nothing scheduled today" compact />
                )
              ) : (
                <div className="space-y-3">
                  {data.today.map(j => (
                    <JobCard
                      key={j.id}
                      job={j}
                      onMarkDone={() => requestMarkDone(j)}
                      onPhotos={() => setPhotoJob(j)}
                      onRespond={(resp) => respond(j, resp)}
                      onDecline={() => requestDecline(j)}
                      onTextClient={() => { setTextNote(''); setTextSent(null); setActionError(null); setTextJob(j) }}
                      onHouseInfo={() => setHouseJob(j)}
                      busy={actionBusy}
                    />
                  ))}
                </div>
              )}
            </section>

            {(data.open_jobs || []).filter(j => j.scheduled_date === data.as_of).length > 0 && (
              <section>
                <SectionLabel className="mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Up for grabs today
                </SectionLabel>
                <div className="space-y-3">
                  {(data.open_jobs || []).filter(j => j.scheduled_date === data.as_of).map(j => (
                    <JobCard key={j.id} job={j} onClaim={() => { setActionError(null); setClaimRate(j.my_claim_request?.requested_rate ?? ''); setClaimMessage(j.my_claim_request?.message || ''); setClaimJob(j) }} busy={actionBusy} />
                  ))}
                </div>
              </section>
            )}


            {/* Save-to-phone + notifications setup. Dismissible here (sticks
                via localStorage); always reachable again from the Me tab. */}
            <CrewSetupCard />
          </>
        )}

        {tab === 'schedule' && (
          /* Segmented control (hairline frame, solid active) — same pattern
             as the photo sheet's Before/After toggle. */
          /* Three segments only when this sub actually has a route — a
             permanent tab for a thing most of the crew doesn't have is chrome. */
          <div className={`grid ${(data?.routes || []).length ? 'grid-cols-3' : 'grid-cols-2'} rounded-lg border border-hairline overflow-hidden text-[12px] font-semibold mb-1`}>
            {[['list', 'Next 2 weeks'], ['month', 'Month'],
              ...((data?.routes || []).length ? [['routes', 'Routes']] : [])].map(([v, l]) => (
              <button key={v} onClick={() => setSchedView(v)} aria-pressed={schedView === v}
                className={`py-1.5 transition-colors ${
                  schedView === v ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 hover:bg-bg-2'}`}>
                {l}
              </button>
            ))}
          </div>
        )}

        {tab === 'schedule' && schedView === 'month' && <CrewMonth />}

        {/* The full route detail — its houses and their shares — is fetched
            here and not in my-day, so an unopened tab costs nothing. */}
        {tab === 'schedule' && schedView === 'routes' && <CrewMyRoutes />}

        {tab === 'schedule' && schedView === 'list' && !loading && !error && data && (data.open_jobs || []).length > 0 && (
          <section>
            <SectionLabel className="mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Up for grabs
            </SectionLabel>
            <div className="space-y-3">
              {(data.open_jobs || []).map(j => (
                <JobCard key={j.id} job={j} onClaim={() => { setActionError(null); setClaimRate(j.my_claim_request?.requested_rate ?? ''); setClaimMessage(j.my_claim_request?.message || ''); setClaimJob(j) }} busy={actionBusy} />
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
                <SectionLabel className="mb-2">{dayLabel(g.date)}</SectionLabel>
                <div className="space-y-3">
                  {g.jobs.map(j => (
                    <JobCard key={j.id} job={j}
                      onRespond={(resp) => respond(j, resp)}
                      onDecline={() => requestDecline(j)}
                      onTextClient={() => { setTextNote(''); setTextSent(null); setActionError(null); setTextJob(j) }}
                      onHouseInfo={() => setHouseJob(j)}
                      busy={actionBusy} />
                  ))}
                </div>
              </section>
            ))
          )
        )}

        {/* Chat is a full-screen thread (the office side pushes replies).
            Closing it re-fetches my-day so the unread badge clears. */}
        {tab === 'chat' && (
          <CrewThread onClose={() => { setTab('today'); fetchDay(true) }} />
        )}

        {tab === 'learn' && <CrewLearn />}

        {tab === 'me' && (
          /* One sectioned accordion instead of six stacked cards: every row
             expands in place, and rows that fetch only do it once opened. */
          <>
            <CrewCard className="px-4">
              <SettingRow icon={CircleUserRound} label="Your info"
                summary="Name, phone, emergency contact">
                <CrewProfile bare />
              </SettingRow>
            </CrewCard>

            <section>
              <SectionLabel className="mb-2">Work</SectionLabel>
              <CrewCard className="px-4 divide-y divide-hairline">
                <SettingRow icon={CalendarClock} label="My availability"
                  summary="Set the weeks ahead — each week locks when it starts">
                  <CrewAvailability bare />
                </SettingRow>
                <SettingRow icon={CalendarOff} label="Time off"
                  summary="Request days off — the office approves">
                  <CrewTimeOff bare />
                </SettingRow>
                {/* Sits under Work, above pay: it's the thing that decides
                    whether there IS any work, and a sub blocked by it needs to
                    find it without being told where to look. */}
                <SettingRow icon={ShieldCheck} label="My file"
                  summary="Agreement, W-9 and insurance — needed to ask for jobs">
                  <CrewMyFile bare />
                </SettingRow>
                <SettingRow icon={DollarSign} label="This week"
                  summary={weekPay
                    ? `Earned ${fmtMoney(weekPay.earned?.gross_pay)} · on track for ${fmtMoney(weekPay.predicted_week_total)}`
                    : 'Your pay, live from your punches'}>
                  <WeekPayBreakdown week={weekPay} onOpenJob={setSheetJobId} />
                </SettingRow>
              </CrewCard>
            </section>

            <section>
              <SectionLabel className="mb-2">Phone</SectionLabel>
              <CrewCard className="px-4 divide-y divide-hairline">
                <SettingRow icon={Smartphone} label="Get set up"
                  summary="Save the app to your phone + notifications">
                  <CrewSetupCard persistent bare />
                </SettingRow>
                <SettingRow icon={CalendarPlus} label="Calendar link"
                  summary="See your jobs in Google or Apple Calendar">
                  <CrewCalendarSync bare />
                </SettingRow>
              </CrewCard>
            </section>

            <button onClick={logout}
              className="w-full text-[13px] font-semibold bg-panel border border-hairline text-red-600 dark:text-red-400 py-2.5 rounded-lg hover:bg-bg-2 transition-colors inline-flex items-center justify-center gap-1.5">
              <LogOut className="w-4 h-4" /> Log out
            </button>
          </>
        )}
      </div>

      <CrewTabBar tab={tab} setTab={setTab} chatUnread={data?.unread_messages || 0} />

      {sheetJobId && (
        <CrewJobSheet jobId={sheetJobId} onClose={() => setSheetJobId(null)} />
      )}

      {markDoneJob && (
        <Sheet onClose={() => setMarkDoneJob(null)} busy={actionBusy}>
          <div>
            <div className="text-base font-bold text-ink">Mark done</div>
            <div className="text-[13px] text-ink-3 mt-0.5 truncate">
              {markDoneJob.property_name || markDoneJob.title}
            </div>
          </div>
          <label className="block">
            <span className="text-[13px] font-medium text-ink-2">Anything for the office?</span>
            <textarea
              value={doneNote} onChange={e => setDoneNote(e.target.value)}
              rows={3} maxLength={2000} autoFocus
              placeholder="Optional — e.g. lockbox was empty, we're low on towels…"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 resize-none"
            />
          </label>
          <ErrorNote>{actionError}</ErrorNote>
          <SheetActions onCancel={() => setMarkDoneJob(null)} onConfirm={confirmMarkDone}
            busy={actionBusy} confirmLabel="Mark done" busyLabel="Saving…" tone="emerald"
            confirmIcon={<CheckCircle2 className="w-4 h-4" />} />
        </Sheet>
      )}
    </div>
  )
}
