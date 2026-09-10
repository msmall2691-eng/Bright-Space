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
import { MapPin, LogOut, RefreshCw, CalendarDays, Clock, Car, DollarSign, CheckCircle2, CalendarRange, CircleUserRound, Sparkles, BookOpen, MessageSquare, Sun, CalendarClock, CalendarOff, Smartphone, CalendarPlus, ShieldCheck, Landmark } from 'lucide-react'
import { get, post as apiPost, patch as apiPatch, del as apiDel, logout } from '../api'
import { toast } from '../utils/toastBus'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'
import JobPhotoSheet from '../components/crew/JobPhotoSheet'
import CrewProfile from '../components/crew/CrewProfile'
import CrewMyFile from '../components/crew/CrewMyFile'
import CrewMyAsks from '../components/crew/CrewMyAsks'
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
import CrewPayoutSetup from '../components/crew/CrewPayoutSetup'
import CrewEarnings from '../components/crew/CrewEarnings'
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


/** The day at a glance — the quiet dashboard strip that makes the home more
 *  than a second jobs list. Three things a subcontractor actually opens the
 *  app to check: what this week is worth, how many jobs are up for grabs, and
 *  whether the office messaged them — each a tap to the tab that owns it. All
 *  three numbers ride the my-day payload (brightbase-economy: no extra fetch).
 *  Plain ink numbers with 11px ink-3 labels, dots only where they carry
 *  meaning (violet = open to crew, amber = unread) — never a count bubble. */
function DayGlance({ week, openCount, unread, onTab }) {
  const cells = [
    { key: 'week', to: 'me', label: 'this week',
      value: week?.week_total != null ? fmtMoney(week.week_total) : '—' },
    { key: 'open', to: 'jobs', label: 'up for grabs', value: openCount,
      dot: openCount > 0 ? 'bg-violet-500' : null },
    { key: 'chat', to: 'chat', label: unread === 1 ? 'message' : 'messages', value: unread,
      dot: unread > 0 ? 'bg-amber-500' : null },
  ]
  return (
    <div className="grid grid-cols-3 divide-x divide-hairline rounded-xl border border-hairline bg-panel">
      {cells.map(c => (
        <button key={c.key} type="button" onClick={() => onTab(c.to)}
          className="min-h-[58px] px-2.5 py-2.5 text-left transition-colors hover:bg-bg-2 active:bg-bg-2 first:rounded-l-xl last:rounded-r-xl">
          <span className="flex items-center gap-1.5">
            {c.dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} aria-hidden="true" />}
            <span className="text-[18px] font-bold text-ink tabular-nums leading-none">{c.value}</span>
          </span>
          <span className="mt-1 block text-[11px] leading-tight text-ink-3">{c.label}</span>
        </button>
      ))}
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
  // The marketplace, given a real home. The open board used to hide on Today
  // (only when nothing was booked) and inside Schedule > list — a free sub had
  // to go looking for the one screen they most want. Now it's one tap.
  { key: 'jobs', label: 'Jobs', icon: Sparkles },
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
      <div className="max-w-lg mx-auto grid grid-cols-6">
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

/** What a blocked write says. One sentence, no jargon. */
const PREVIEW_BLOCKED =
  'This is a preview of what they see — you can’t act on their behalf.'

const previewBlocked = () => Promise.reject(new Error(PREVIEW_BLOCKED))

export default function MyDay({ previewUserId = null }) {
  // PREVIEW MODE: an office role looking at a named cleaner's screen.
  //
  // ONE CHOKE POINT instead of nine guards. Every write in this file goes
  // through `post`, `patch` or `del`, so swapping them here covers mark-done,
  // respond, decline, claim, notify-client, the text sheet and both helper
  // calls at once — and any write somebody adds later, which is the part a
  // per-button guard would miss.
  //
  // The API refuses these anyway: every mutating /api/crew route is
  // Depends(require_role("cleaner")) and require_role has no admin bypass, so
  // an office session gets a 403 whatever the screen renders. This layer
  // exists so the screen says WHY instead of showing a failure.
  //
  // The buttons stay visible on purpose. The point of the preview is to see
  // what the cleaner sees, and a screen with its buttons removed is not that.
  //
  // It matters more than tidiness: an office user tapping Accept for a
  // subcontractor would be ASSIGNING them work, and a sub requests or accepts
  // and is never assigned (brightbase-marketplace, Rule 0).
  const preview = previewUserId != null
  const post = preview ? previewBlocked : apiPost
  const patch = preview ? previewBlocked : apiPatch
  const del = preview ? previewBlocked : apiDel

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
  // Who I'm bringing (migration 107) — see the sheet at the bottom.
  const [helperJob, setHelperJob] = useState(null)
  const [helperName, setHelperName] = useState('')
  const [helperPhone, setHelperPhone] = useState('')
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
    return get(preview
      ? `/api/crew/preview/${previewUserId}/my-day?days=14`
      : '/api/crew/my-day?days=14')
      .then(d => {
        setData(d); setStaleAt(null)
        // Offline resilience: keep the last good day on the device, so one
        // bar of service in a driveway still shows the schedule + door
        // codes (which matter most exactly where signal is worst).
        // Not in preview: this cache is "my day, for when I have no signal",
        // and writing another person's jobs into it would both mislead the
        // office later and leave a cleaner's addresses on an office laptop.
        if (preview) return
        try {
          localStorage.setItem('bb_myday_cache',
            JSON.stringify({ data: d, savedAt: Date.now() }))
        } catch { /* storage full/blocked — cache is a bonus, not a need */ }
      })
      .catch(e => {
        // Server unreachable → fall back to the cached copy instead of a
        // dead error screen. Actions still fail loudly; reading works.
        try {
          // Same reason in reverse: a failed preview must not quietly show the
          // viewer's own cached day under somebody else's name.
          const c = preview
            ? null
            : JSON.parse(localStorage.getItem('bb_myday_cache') || 'null')
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
    // /api/crew/my-week resolves from the CALLER, so in preview it would be
    // the office user's own week shown under the cleaner's name — an empty
    // pay card that looks like the cleaner earned nothing. Better to show
    // nothing than a confident wrong number.
    if (preview) return undefined
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
      // Instant claim (Turno-style): at or below the posted price the job is
      // already theirs by the time this returns, so "we'll let you know" would
      // be false — the version of false that makes someone ring the office to
      // ask. Only an above-posted offer actually waits for a person.
      toast.success(res?.auto_approved
        ? 'It’s yours — it’s on your schedule now.'
        : 'Offer sent. The office will confirm this one.')
      await fetchDay(true)
    }
    catch (e) {
      setActionError(e.detail || e.message || 'Could not send your request')
      if (e.status === 409) { setClaimJob(null); await fetchDay(true) }
    }
    finally { setActionBusy(false) }
  }, [claimJob, claimRate, claimMessage, fetchDay])

  // BRINGING SOMEONE (migration 107). One of the five Maine criteria for this
  // arrangement is that a subcontractor hires, pays and supervises their own
  // assistants — the app modelled one cleaner per job, so there was nowhere to
  // say it. The office is told (somebody they've never met will be in a
  // customer's house) and does not approve: this is the sub's call.
  const addHelper = useCallback(async () => {
    if (!helperJob) return
    const name = helperName.trim()
    if (!name) { setActionError('Who are you bringing?'); return }
    setActionBusy(true); setActionError(null)
    try {
      await post(`/api/crew/jobs/${helperJob.id}/helpers`,
                 { name, phone: helperPhone.trim() || null })
      setHelperName(''); setHelperPhone('')
      toast.success(`${name} is on the job with you`)
      await fetchDay(true)
      setHelperJob(null)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not add them') }
    finally { setActionBusy(false) }
  }, [helperJob, helperName, helperPhone, fetchDay])

  const removeHelper = useCallback(async (id) => {
    if (!helperJob) return
    setActionBusy(true); setActionError(null)
    try {
      await del(`/api/crew/jobs/${helperJob.id}/helpers/${id}`)
      await fetchDay(true)
      setHelperJob(null)
    }
    catch (e) { setActionError(e.detail || e.message || 'Could not remove them') }
    finally { setActionBusy(false) }
  }, [helperJob, fetchDay])

  // Correct the miles on an already-closed punch (from the Today's punches list).

  // THE HEADER DATE, and its absence is why this screen was blank.
  //
  // PR #777 ("Delete the employee model") removed the time-clock block this
  // was declared beside, and left the `{longDate}` in the header below. A bare
  // undefined identifier is not a build error — Vite has to assume it might be
  // a browser global — so it shipped, and every cleaner opening My Day got
  // `ReferenceError: longDate is not defined` at render. The crew branch had
  // no ErrorBoundary either, so the result was a white page with nothing to
  // report. "It just goes blank."
  //
  // Derived from the payload's own business date rather than the device clock:
  // `as_of` is the day the schedule below is FOR, resolved in Maine time on
  // the server. A phone in another timezone, or one whose clock is wrong,
  // should not caption today's jobs with yesterday.
  const longDate = (() => {
    const iso = data?.as_of
    const d = iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`) : now
    return (Number.isNaN(d?.getTime?.()) ? now : d).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    })
  })()

  // Does the Today section stand in for the open-jobs board? It does whenever
  // nothing is booked and there IS something to offer — and when it does, the
  // separate "Up for grabs today" section below must not render the same rows
  // again. One flag, read in both places, so the two can't drift back apart.
  const boardIsToday = !!data && (data.today || []).length === 0
    && (data.open_jobs || []).length > 0

  return (
    <div className="min-h-screen bg-bg">
      {preview && (
        /* Whose day this is, and that it cannot be acted on. A quiet line
           above the app rather than a tinted banner, and it stays put while
           the screen scrolls so the answer to "wait, whose is this?" is
           always on screen. */
        <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline bg-bg-2 px-4 py-2 text-[12px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" aria-hidden="true" />
            Preview —{' '}
            <span className="text-ink">
              {data?.preview?.cleaner_name || 'this cleaner'}
            </span>
            ’s app
          </span>
          <a href="/crew" className="text-ink-3 underline underline-offset-2 hover:text-indigo-600">
            Back to Crew
          </a>
        </div>
      )}
      <div className="sticky top-0 z-10 safe-top bg-panel">
        <header className="bg-panel border-b border-hairline px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-ink">
              {tab === 'jobs' ? 'Open jobs' : tab === 'schedule' ? 'My Schedule' : tab === 'me' ? 'Me' : tab === 'learn' ? 'Learn' : tab === 'chat' ? 'Chat' : 'My Day'}
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

            {/* The day at a glance — what makes this a home and not the jobs
                list. Only for a sub who can actually take work; a not-cleared
                sub gets the file card below instead of a row of zeros. */}
            {data.cleared !== false && (
              <DayGlance
                week={data.week}
                openCount={(data.open_jobs || []).length}
                unread={data.unread_messages || 0}
                onTab={setTab}
              />
            )}

            {/* NOT CLEARED YET — the biggest drop-off in a new sub's first week.
                Their board is empty by the vetting gate, and without this the
                screen says "Nothing scheduled today" — identical to a dead
                market. Says why, lists what's left (the office's own ordered
                sentences), and points at the file. Explicit === false so a
                stale cache or a non-sub (cleared undefined) never triggers it.
                Quiet dot + card, not a tinted banner (design language). */}
            {data.cleared === false && (data.missing || []).length > 0 && (
              <div className="rounded-xl border border-hairline bg-panel px-4 py-3">
                <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  You're not cleared to take jobs yet
                </span>
                <p className="mt-0.5 text-[13px] text-ink">
                  Finish your file and the office clears you — then open jobs
                  show up right here.
                </p>
                <ul className="mt-2 space-y-1">
                  {(data.missing || []).map((m, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-ink-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/50" aria-hidden="true" />
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => setTab('me')}
                  className="mt-3 w-full rounded-lg border border-hairline bg-bg-2 py-2 text-[13px] font-semibold text-ink hover:bg-bg transition-colors">
                  Go to my file
                </button>
              </div>
            )}

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
                <SectionLabel>{boardIsToday ? 'Up for grabs' : 'Today'}</SectionLabel>
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
                    {(data.open_jobs || []).map(j => (
                      /* showDate: this list is the whole board, not one day —
                         without it every offer reads as today's. */
                      <JobCard key={j.id} job={j} busy={actionBusy} showDate
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
                      onHelpers={() => { setActionError(null); setHelperName(''); setHelperPhone(''); setHelperJob(j) }}
                      busy={actionBusy}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* THE BOARD RENDERS IN EXACTLY ONE PLACE ON THIS TAB. When nothing
                is booked the Today section IS the board (above), so repeating
                today's offers here showed every one of them twice — a sub
                scrolling a short board could not tell two jobs from one. */}
            {!boardIsToday && (data.open_jobs || []).filter(j => j.scheduled_date === data.as_of).length > 0 && (
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

        {/* THE MARKETPLACE, given a real home. Every open job on offer, grouped
            by day, each one claimable right here — the discovery surface a free
            sub actually wants. Same open_jobs the payload already carries (no
            new fetch, no tick — brightbase-economy); identity stays stripped
            server-side until a job is won (Rule 0). */}
        {tab === 'jobs' && !loading && !error && data && (() => {
          const open = [...(data.open_jobs || [])].sort(
            (a, b) => String(a.scheduled_date || '').localeCompare(String(b.scheduled_date || '')))
          if (data.cleared === false && (data.missing || []).length > 0) {
            return (
              <div className="rounded-xl border border-hairline bg-panel px-4 py-3">
                <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  You're not cleared to take jobs yet
                </span>
                <p className="mt-0.5 text-[13px] text-ink">
                  Finish your file and the office clears you — then open jobs
                  show up right here to claim.
                </p>
                <ul className="mt-2 space-y-1">
                  {(data.missing || []).map((m, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-ink-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3/50" aria-hidden="true" />
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => setTab('me')}
                  className="mt-3 w-full rounded-lg border border-hairline bg-bg-2 py-2 text-[13px] font-semibold text-ink hover:bg-bg transition-colors">
                  Go to my file
                </button>
              </div>
            )
          }
          if (open.length === 0) {
            return (
              <EmptyState icon={Sparkles} compact
                title="No open jobs right now"
                description="When the office posts work to the bench it shows up here — ask for one and you'll hear back." />
            )
          }
          return (
            <>
              <SectionLabel className="mb-1">
                {open.length} open {open.length === 1 ? 'job' : 'jobs'}
              </SectionLabel>
              {groupByDate(open).map(g => (
                <section key={g.date}>
                  <SectionLabel className="mb-2">{dayLabel(g.date)}</SectionLabel>
                  <div className="space-y-3">
                    {g.jobs.map(j => (
                      <JobCard key={j.id} job={j} busy={actionBusy}
                        onClaim={() => { setActionError(null); setClaimRate(j.my_claim_request?.requested_rate ?? ''); setClaimMessage(j.my_claim_request?.message || ''); setClaimJob(j) }} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )
        })()}

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
                <JobCard key={j.id} job={j} showDate onClaim={() => { setActionError(null); setClaimRate(j.my_claim_request?.requested_rate ?? ''); setClaimMessage(j.my_claim_request?.message || ''); setClaimJob(j) }} busy={actionBusy} />
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
                      onHelpers={() => { setActionError(null); setHelperName(''); setHelperPhone(''); setHelperJob(j) }}
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
                {/* The jobs this sub asked for and what happened to each —
                    fetched once opened. Leads the section: it's the thing a
                    free sub checks, and where a request goes after it leaves
                    the board (once someone's picked). Withdraw lives here. */}
                <SettingRow icon={Sparkles} label="My asks"
                  summary="Jobs you've asked for, and what happened">
                  <CrewMyAsks />
                </SettingRow>
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
                {/* Sits right above "This week": the money screen is where
                    somebody wonders how the money actually reaches them. */}
                <SettingRow icon={Landmark} label="Direct deposit"
                  summary="Get paid to your bank — optional">
                  <CrewPayoutSetup />
                </SettingRow>
                {/* What the office has recorded owing you, per job (BB-PAY-01) —
                    the ledger, distinct from where the money goes above. */}
                <SettingRow icon={DollarSign} label="What you're owed"
                  summary="Your payouts, per job — owed and paid">
                  <CrewEarnings />
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
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 resize-none"
            />
          </label>
          <ErrorNote>{actionError}</ErrorNote>
          <SheetActions onCancel={() => setMarkDoneJob(null)} onConfirm={confirmMarkDone}
            busy={actionBusy} confirmLabel="Mark done" busyLabel="Saving…" tone="emerald"
            confirmIcon={<CheckCircle2 className="w-4 h-4" />} />
        </Sheet>
      )}

      {helperJob && (
        <Sheet onClose={() => { setHelperJob(null); setActionError(null) }} busy={actionBusy}>
          <div>
            <div className="text-base font-bold text-ink">Bringing someone?</div>
            <div className="text-[13px] text-ink-3 mt-0.5 truncate">
              {helperJob.property_name || helperJob.title}
            </div>
          </div>

          {/* Said first, because it is the first question and the honest answer
              is what makes this the sub's assistant rather than the company's:
              the job's rate is the job's rate, and they pay their own help. */}
          <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-ink-3/50 shrink-0" aria-hidden="true" />
            <span>Your rate for this job doesn’t change — you’re bringing them,
              and you settle up with them. We just need to know who’s at the house.</span>
          </p>

          {(helperJob.my_helpers?.length || 0) > 0 && (
            <div className="space-y-1.5">
              {helperJob.my_helpers.map(h => (
                <div key={h.id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-panel px-3 py-2">
                  <span className="min-w-0 text-[13px] text-ink truncate">
                    {h.name}{h.phone ? <span className="text-ink-3"> · {h.phone}</span> : null}
                  </span>
                  <button type="button" onClick={() => removeHelper(h.id)} disabled={actionBusy}
                    className="shrink-0 text-[12px] font-medium text-ink-3 hover:text-ink-2 disabled:opacity-60">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <label className="block">
            <span className="text-[13px] font-medium text-ink-2">Their name</span>
            <input value={helperName} onChange={e => setHelperName(e.target.value)}
              maxLength={120} autoFocus placeholder="e.g. Sam Reed"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium text-ink-2">Their number <span className="text-ink-3 font-normal">· optional</span></span>
            <input value={helperPhone} onChange={e => setHelperPhone(e.target.value)}
              type="tel" maxLength={32} placeholder="If the office needs to reach the house"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
          </label>
          <ErrorNote>{actionError}</ErrorNote>
          <SheetActions onCancel={() => { setHelperJob(null); setActionError(null) }}
            onConfirm={addHelper} busy={actionBusy}
            confirmLabel="Add them" busyLabel="Saving…" tone="emerald"
            confirmIcon={<CheckCircle2 className="w-4 h-4" />} />
        </Sheet>
      )}

      {/* Photos after a clean — the sheet owns capture, the WiFi queue, and the
          before/after toggle. Removed with the employee code in #777; the
          Photos button on every job card had been dead ever since. */}
      {photoJob && (
        <JobPhotoSheet job={photoJob} onClose={() => setPhotoJob(null)} />
      )}

      {/* House photos & all notes — the access details a cleaner needs at the
          door. Same #777 casualty as the photo sheet. */}
      {houseJob && (
        <PropertySheet propertyId={houseJob.property_id}
          propertyName={houseJob.property_name}
          onClose={() => setHouseJob(null)} />
      )}

      {/* Text the client from the company number. Templates unlock the day
          before ("see you tomorrow") and the day of ("on the way"); their
          number stays private and every send is logged for the office. */}
      {textJob && (() => {
        const tomorrow = (() => {
          const d = new Date(`${data?.as_of}T12:00`); d.setDate(d.getDate() + 1)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        })()
        const canOnTheWay = textJob.scheduled_date === data?.as_of
        const canTomorrow = textJob.scheduled_date === tomorrow
        return (
          <Sheet onClose={() => setTextJob(null)} busy={actionBusy}>
            <div>
              <div className="text-base font-bold text-ink">Text {textJob.client_name || 'the client'}</div>
              <div className="text-[11px] text-ink-3 mt-0.5">
                Sent from the company number and logged for the office — their
                number stays private.
              </div>
            </div>
            {textSent ? (
              <>
                <div className="text-[12.5px] text-ink-2 flex items-start gap-1.5">
                  <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <span>Sent — “{textSent}”</span>
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
                        className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] text-ink focus:outline-hidden focus:border-blue-400" />
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
                <ErrorNote>{actionError}</ErrorNote>
              </>
            )}
          </Sheet>
        )
      })()}

      {/* THE MARKETPLACE. Asking for an open job files a request at the posted
          rate or a counter — it never assigns (Rule 0). Removed with the
          employee code in #777, which left every "Ask for this job" button
          setting state that nothing rendered: no sheet, no rate field, no
          feedback. This is the sheet that makes the sub side of the
          marketplace real. */}
      {claimJob && (() => {
        // A claim is INSTANT ("it's yours the moment you claim") only when the
        // office has instant claiming on (backend `instant_claim`, off by
        // default), the job is priced, and they aren't bidding above the posted
        // price. Otherwise it's a request the office decides. The sheet reacts
        // to what they type AND to the office's setting, so the button never
        // promises "instant" for something that will actually wait.
        const posted = claimJob.posted_rate
        const entered = String(claimRate).trim() === '' ? null : Number(String(claimRate).trim())
        const abovePosted = posted != null && entered != null && entered > posted
        const willBeInstant = !!claimJob.instant_claim && !abovePosted
        return (
        <Sheet onClose={() => setClaimJob(null)} busy={actionBusy}>
          <div>
            <div className="text-base font-bold text-ink">
              {willBeInstant ? 'Claim this job'
                : posted == null || abovePosted ? 'Make an offer'
                : 'Ask for this job'}
            </div>
            <div className="text-[13px] text-ink-3 mt-0.5 truncate">
              {claimJob.property_name || claimJob.title}
              {claimJob.scheduled_date ? ` · ${claimJob.scheduled_date === data?.as_of ? 'Today' : dayLabel(claimJob.scheduled_date)}` : ''}
              {claimJob.start_time ? ` · ${fmtTimeRange(claimJob.start_time, claimJob.end_time)}` : ''}
            </div>
          </div>
          {posted != null ? (
            <p className="text-[13px] text-ink-2">
              Pays{' '}
              <span className="font-semibold text-ink">
                ${Number(posted).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>. Leave the box empty to take it at that.
            </p>
          ) : (
            /* No posted price: there's no anchor for an instant claim, so it
               becomes an offer the office prices. Say what's needed rather than
               letting a blank field 422. */
            <p className="flex items-start gap-1.5 text-[13px] text-ink-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              <span>No price on this one — say what you'd do it for.</span>
            </p>
          )}
          <label className="block">
            <span className="text-[13px] font-medium text-ink-2">
              {posted != null ? 'Want a different rate? (optional)' : 'Your rate'}
            </span>
            <input
              type="number" inputMode="decimal" min="1" step="1"
              value={claimRate} onChange={e => setClaimRate(e.target.value)}
              autoFocus={posted == null}
              placeholder={posted != null ? `${Number(posted)}` : 'e.g. 120'}
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-base text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400"
            />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium text-ink-2">Anything to add? (optional)</span>
            <textarea
              value={claimMessage} onChange={e => setClaimMessage(e.target.value)}
              rows={2} maxLength={2000}
              placeholder="e.g. I'm five minutes away, I bring my own supplies…"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 resize-none"
            />
          </label>
          {willBeInstant ? (
            <p className="text-[12px] text-ink-3">
              It's yours the moment you claim — first to claim gets it. Address
              details unlock right after.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-[12px] text-ink-3">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              <span>{abovePosted
                ? "That's above the posted price, so the office confirms this one."
                : posted == null
                  ? 'The office will price it and confirm.'
                  : 'The office confirms who gets it — you’ll hear back.'}</span>
            </p>
          )}
          <ErrorNote>{actionError}</ErrorNote>
          <SheetActions onCancel={() => setClaimJob(null)} onConfirm={confirmClaim}
            busy={actionBusy}
            confirmLabel={willBeInstant ? 'Claim it' : 'Send request'}
            busyLabel={willBeInstant ? 'Claiming…' : 'Sending…'}
            confirmIcon={<Sparkles className="w-4 h-4" />} />
        </Sheet>
        )
      })()}

      {/* "Can't make it" on an assigned job. Records a declined status with an
          optional reason; the sub stays on the job until the office reassigns
          it (Rule 0 — the office never silently moves the work). #777 casualty. */}
      {declineJob && (
        <Sheet onClose={() => setDeclineJob(null)} busy={actionBusy}>
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
              className="mt-1.5 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 resize-none"
            />
          </label>
          <ErrorNote>{actionError}</ErrorNote>
          <SheetActions onCancel={() => setDeclineJob(null)}
            onConfirm={() => respond(declineJob, 'declined', declineReason.trim() || undefined)}
            busy={actionBusy} confirmLabel="Send" busyLabel="Sending…" tone="amber" />
        </Sheet>
      )}
    </div>
  )
}
