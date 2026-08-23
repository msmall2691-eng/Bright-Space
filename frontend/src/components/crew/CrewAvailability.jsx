/**
 * Me tab — availability (crew app Phase 4b: week-anchored).
 *
 * Two layers, physically separated so the recurring-vs-instance trap can't
 * bite (design-review finding):
 *
 *  - WEEK STRIP: "‹ Week of Mon Aug 17 ›" — the current week renders as a
 *    LOCKED read-only summary (the office schedules from it; changes this
 *    week go through the office), the next 8 weeks are editable grids.
 *    Editable weeks pre-fill from the usual-week template, but Save only
 *    activates on a real change — an untouched prefill never becomes a
 *    saved week row (which would silently stop tracking template fixes).
 *    Weeks you explicitly saved are badged "Set by you" and carry a
 *    "Back to usual week" undo.
 *
 *  - "MY USUAL WEEK" opens behind its own tap-through row below the strip —
 *    the default for any week you haven't set specifically.
 *
 * All lock state and week math come from the SERVER (business timezone):
 * the phone's clock is never trusted. Every save flashes its blast radius
 * ("Saved — week of Aug 17 only" vs "applies to weeks you haven't set").
 */
import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Lock, Undo2 } from 'lucide-react'
import { get, put, del } from '../../api'
import { Skeleton } from '../ui'
import { ErrorNote } from './primitives'

const DAYS = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
  ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
]
const EMPTY_WEEK = Object.fromEntries(DAYS.map(([k]) => [k, []]))
// First-time template default: weekdays fully on, weekend off.
const DEFAULT_WEEK = { ...EMPTY_WEEK, mon: ['am', 'pm'], tue: ['am', 'pm'], wed: ['am', 'pm'], thu: ['am', 'pm'], fri: ['am', 'pm'] }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clone = (w) => JSON.parse(JSON.stringify(w || EMPTY_WEEK))
// Noon idiom: new Date('YYYY-MM-DD') UTC-parses and shifts a day in Eastern.
const dateAt = (ymd) => new Date(`${ymd}T12:00`)
const fmtShort = (ymd) => dateAt(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const weekLabel = (ymd) => {
  const start = dateAt(ymd)
  const end = new Date(start); end.setDate(end.getDate() + 6)
  return `Mon ${fmtShort(ymd)} – Sun ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function WeekGridEditor({ week, onToggle, disabled }) {
  return (
    <div className="space-y-1.5">
      {DAYS.map(([key, label]) => (
        <div key={key} className="flex items-center gap-2">
          <span className="w-9 text-[12px] font-semibold text-ink-2">{label}</span>
          <div className="flex-1 grid grid-cols-2 gap-1.5">
            {['am', 'pm'].map(slot => {
              const on = (week[key] || []).includes(slot)
              return (
                <button key={slot} onClick={() => onToggle(key, slot)} disabled={disabled}
                  aria-pressed={on}
                  className={`py-1.5 rounded-lg text-[12px] font-semibold border transition-colors disabled:opacity-50 ${
                    on
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-bg border-hairline text-ink-3'}`}>
                  {slot === 'am' ? 'Morning' : 'Afternoon'}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** The locked current week: a summary, never a grid — a "locked" grid whose
 *  chips shift when the template changes reads as a broken lock. */
function LockedWeekSummary({ entry, template }) {
  const src = entry.week || template
  const workDays = src
    ? DAYS.filter(([k]) => (src[k] || []).length > 0)
        .map(([k, l]) => `${l} ${((src[k] || []).length === 2) ? 'all day' : (src[k][0] === 'am' ? 'morning' : 'afternoon')}`)
    : null
  return (
    <div className="rounded-xl border border-hairline bg-bg-2 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
        <Lock className="w-3.5 h-3.5 text-ink-3" /> This week is locked
      </div>
      <p className="text-[12px] text-ink-2">
        {entry.week
          ? 'You set this before the week started:'
          : src
            ? 'No plan saved for this week — your usual week applies:'
            : "No availability on file for this week."}
      </p>
      {workDays && (
        <p className="text-[12px] text-ink font-medium">
          {workDays.length ? workDays.join(' · ') : 'Off all week'}
        </p>
      )}
      <p className="text-[11px] text-ink-3">
        The office schedules from this. Need a change this week? Contact the office.
      </p>
    </div>
  )
}

export default function CrewAvailability({ bare = false }) {
  const [data, setData] = useState(null)         // full GET payload
  const [idx, setIdx] = useState(0)              // strip position (0 = current week)
  const [draft, setDraft] = useState(null)       // edited copy for the shown week
  const [showTemplate, setShowTemplate] = useState(false)
  const [tmplDraft, setTmplDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)       // one-line save confirmation
  const [error, setError] = useState(null)

  const load = useCallback(async (keepIdx = true) => {
    try {
      const d = await get('/api/crew/me/availability')
      setData(d)
      setError(null)
      if (!keepIdx) setIdx(0)
      return d
    } catch (e) {
      setError(e.detail || e.message || 'Could not load availability')
      return null
    }
  }, [])
  useEffect(() => { load(false) }, [load])

  // Re-check lock state whenever the tab regains focus — a grid must never
  // sit editable across the business-timezone midnight.
  useEffect(() => {
    const onFocus = () => { load() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  useEffect(() => {
    if (!flash) return undefined
    const t = setTimeout(() => setFlash(null), 3000)
    return () => clearTimeout(t)
  }, [flash])

  // Reset the draft whenever the shown week (or fresh data) changes.
  const entry = data?.weeks?.[idx]
  const template = data?.week || null
  const prefill = entry ? (entry.week || template || DEFAULT_WEEK) : null
  useEffect(() => {
    setDraft(prefill ? clone(prefill) : null)
  }, [data, idx])  // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <ErrorNote>{error}</ErrorNote>
  if (!data || !entry) return <Skeleton className="h-56 w-full rounded-xl" />

  const dirty = draft && !same(draft, prefill)
  const isSet = entry.source === 'set'

  const toggle = (day, slot) => {
    setDraft(prev => {
      const has = (prev[day] || []).includes(slot)
      const slots = has ? prev[day].filter(s => s !== slot) : [...(prev[day] || []), slot].sort()
      return { ...prev, [day]: slots }
    })
  }

  const saveWeek = async () => {
    setBusy(true); setError(null)
    try {
      const res = await put('/api/crew/me/availability/week',
        { week_start: entry.week_start, week: draft })
      await load()
      const warn = (res.uncovered_jobs || []).length
      setFlash(warn
        ? `Saved — but you're assigned ${res.uncovered_jobs[0].title} on ${fmtShort(res.uncovered_jobs[0].scheduled_date)}. The office has been notified.`
        : `Saved — week of ${fmtShort(res.week_start)} only`)
    } catch (e) {
      // A 409 means the week locked while editing (midnight passed) — refetch
      // so the strip shows the truth instead of a doomed editable grid.
      setError(e.detail || e.message || 'Could not save')
      if (e.status === 409) await load()
    } finally {
      setBusy(false)
    }
  }

  const revertWeek = async () => {
    setBusy(true); setError(null)
    try {
      await del(`/api/crew/me/availability/week?week_start=${entry.week_start}`)
      await load()
      setFlash(`Back to your usual week for ${fmtShort(entry.week_start)}`)
    } catch (e) {
      setError(e.detail || e.message || 'Could not revert')
      if (e.status === 409) await load()
    } finally {
      setBusy(false)
    }
  }

  const saveTemplate = async () => {
    setBusy(true); setError(null)
    try {
      await put('/api/crew/me/availability', { week: tmplDraft })
      await load()
      setFlash("Saved — applies to weeks you haven't set specifically")
      setShowTemplate(false)
    } catch (e) {
      setError(e.detail || e.message || 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={bare ? 'space-y-3' : 'bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 space-y-3'}>
      <div>
        {!bare && (
          <div className="text-sm font-bold text-ink flex items-center gap-1.5">
            <CalendarClock className="w-4 h-4 text-ink-3" /> My availability
          </div>
        )}
        <p className={`text-[11px] text-ink-3 ${bare ? '' : 'mt-0.5'}`}>
          Set the weeks ahead — the office sees this when assigning. Each week
          locks when it starts.
        </p>
      </div>

      {/* Week strip */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0 || busy}
          aria-label="Previous week"
          className="grid place-items-center w-8 h-8 rounded-lg bg-bg-2 text-ink-2 disabled:opacity-40 active:scale-95 transition-transform">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-center min-w-0">
          <div className="text-[13px] font-bold text-ink truncate">{weekLabel(entry.week_start)}</div>
          <div className="text-[10px] text-ink-3">
            {entry.locked ? 'Locked' : isSet ? 'Set by you' : 'Usual week'}
            {idx === 0 ? ' · this week' : idx === 1 ? ' · next week' : ''}
          </div>
        </div>
        <button onClick={() => setIdx(i => Math.min(data.weeks.length - 1, i + 1))}
          disabled={idx >= data.weeks.length - 1 || busy}
          aria-label="Next week"
          className="grid place-items-center w-8 h-8 rounded-lg bg-bg-2 text-ink-2 disabled:opacity-40 active:scale-95 transition-transform">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {entry.locked ? (
        <LockedWeekSummary entry={entry} template={template} />
      ) : (
        <>
          <WeekGridEditor week={draft || EMPTY_WEEK} onToggle={toggle} disabled={busy} />
          {isSet && !dirty && (
            <button onClick={revertWeek} disabled={busy}
              className="w-full text-[12px] font-semibold text-ink-2 bg-bg-2 border border-hairline py-2 rounded-lg hover:bg-bg-3 disabled:opacity-60 inline-flex items-center justify-center gap-1.5 transition-colors">
              <Undo2 className="w-3.5 h-3.5" /> Back to usual week
            </button>
          )}
          {dirty && (
            <button onClick={saveWeek} disabled={busy}
              className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
              {busy ? 'Saving…' : `Save week of ${fmtShort(entry.week_start)}`}
            </button>
          )}
        </>
      )}

      {flash && (
        <div className="text-[12px] text-ink-2 flex items-start gap-1.5">
          <BadgeCheck className="w-4 h-4 shrink-0 mt-[1px] text-emerald-600 dark:text-emerald-400" />
          <span>{flash}</span>
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>

      {/* The recurring template lives behind its own tap-through so a
          one-week change and a permanent change can't be typed into the
          same-looking grid by accident. */}
      <div className="border-t border-hairline pt-2.5">
        <button onClick={() => {
          setShowTemplate(v => !v)
          setTmplDraft(clone(template || DEFAULT_WEEK))
        }}
          className="w-full flex items-center justify-between text-[12.5px] font-semibold text-ink-2 py-1">
          <span>My usual week{template ? '' : ' — not set yet'}</span>
          <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${showTemplate ? 'rotate-180' : ''}`} />
        </button>
        {showTemplate && tmplDraft && (
          <div className="mt-2 space-y-3">
            <p className="text-[11px] text-ink-3">
              The default for every week you haven't set specifically. Weeks
              you've set keep what you set.
            </p>
            <WeekGridEditor week={tmplDraft}
              onToggle={(day, slot) => setTmplDraft(prev => {
                const has = (prev[day] || []).includes(slot)
                const slots = has ? prev[day].filter(s => s !== slot) : [...(prev[day] || []), slot].sort()
                return { ...prev, [day]: slots }
              })}
              disabled={busy} />
            <button onClick={saveTemplate} disabled={busy || same(tmplDraft, template || DEFAULT_WEEK)}
              className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
              {busy ? 'Saving…' : 'Save usual week'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
