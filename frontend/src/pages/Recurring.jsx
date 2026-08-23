import { useState, useEffect, useMemo, useCallback } from 'react'
import { groupBulkable, describeBatch, applyBatch } from '../utils/recurringBulk'
import { useSearchParams, Link } from 'react-router-dom'
import {
  Calendar, Repeat, RefreshCw, Plus, X, ArrowLeft, Pencil,
  SkipForward, Clock, Undo2, Pause, Play, AlertTriangle,
} from 'lucide-react'
import { get, post, put, patch, del } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import EmptyState from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import ErrorNote from '../components/ui/ErrorNote'
import SubNav from '../components/ui/SubNav'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import {
  groupDuplicateSeries, isLiveSeries, suggestKeeper, seriesState, SERIES_STATE_LABEL,
  loadReviewedDupKeys, saveReviewedDupKeys,
} from '../utils/recurringDuplicates'
import { useEmployees } from '../hooks/useEmployees'
import EndsPicker from '../components/schedule/EndsPicker'
import JobCreateModal from '../components/JobCreateModal'

/** Resolve a roster employee to an id+name pair, defensively. Mirrors
 *  JobEditModal's normalizeEmployee — legacy roster rows carry shapes like
 *  { userId, firstName, lastName, displayName }; native rows are { id, name }. */
function normalizeEmployee(e) {
  const id = String(e?.id ?? e?.userId ?? '')
  const composed = [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim()
  const name = e?.name || e?.displayName || composed || `Cleaner ${id}`
  return { id, name }
}

/**
 * /recurring — dedicated management surface for recurring bookings.
 *
 * Answers the user's core ask: "if one week someone needs us to come in the
 * afternoon, the future visits won't be affected." That's the per-visit-vs-
 * future-visits distinction the UI has to make legible.
 *
 * Layout:
 *  - LIST (?series= not set): every active/paused series across all clients.
 *  - DETAIL (?series=<id>): the picked series with two clearly separated
 *    action groups:
 *      1) "Just this visit"   — Skip / Reschedule per upcoming occurrence.
 *      2) "All future visits" — edit the rule (freq / days / times / duration).
 *    Plus an exception log with Undo, and pause / cancel controls.
 *
 * Backend surface used:
 *   GET  /api/recurring                       list
 *   GET  /api/recurring/:id                   one
 *   PATCH /api/recurring/:id                  edit rule / pause / resume
 *   DELETE /api/recurring/:id                 cancel (soft-delete)
 *   POST /api/recurring/:id/generate          re-materialize jobs
 *   POST /api/recurring/:id/skip              skip a specific date
 *   POST /api/recurring/:id/reschedule        reschedule a specific date
 *   GET  /api/recurring/:id/exceptions        list overrides
 *   DELETE /api/recurring/:id/exceptions/:eid undo one override
 */

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Backend and shared frontend convention: Python weekday numbering
// (Mon=0..Sun=6). JS Date.getDay() returns Sun=0..Sat=6, so we translate.
const pyWeekday = (d) => (d.getDay() + 6) % 7
const isoDate = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const parseISO = (s) => {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
// Monday that starts d's week — the unit biweekly cadence is counted in.
const mondayOf = (d) => { const m = new Date(d); m.setDate(m.getDate() - pyWeekday(d)); m.setHours(0, 0, 0, 0); return m }
const daysBetween = (a, b) => Math.round((a - b) / 86400000)

function ruleSummary(s) {
  if (!s) return ''
  if (s.frequency === 'monthly') {
    return `Monthly on day ${s.day_of_month || 1}`
  }
  const days = (s.days_of_week && s.days_of_week.length)
    ? s.days_of_week : [s.day_of_week ?? 0]
  const dayStr = days.slice().sort((a, b) => a - b).map(d => DAY_LABELS[d]).join(', ')
  if (s.frequency === 'daily') {
    const step = Math.max(1, s.interval_weeks || 1)
    return step === 1 ? `Every day${days.length < 7 ? ` (${dayStr})` : ''}`
                      : `Every ${step} days${days.length < 7 ? ` (${dayStr})` : ''}`
  }
  const interval = s.interval_weeks || (s.frequency === 'biweekly' ? 2 : 1)
  const cadence = interval === 1 ? 'Weekly' : interval === 2 ? 'Biweekly' : `Every ${interval} weeks`
  return `${cadence} on ${dayStr}`
}

function endsSummary(s) {
  if (!s) return ''
  if (s.ends_mode === 'after_count' && s.series_end_occurrences) {
    return `Ends after ${s.series_end_occurrences} visit${s.series_end_occurrences === 1 ? '' : 's'}`
  }
  if (s.ends_mode === 'on_date' && s.ends_on) return `Ends ${fmtDate(s.ends_on)}`
  return 'Never ends'
}

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hh = parseInt(h, 10)
  const ampm = hh >= 12 ? 'pm' : 'am'
  const h12 = hh % 12 || 12
  return `${h12}:${m}${ampm}`
}
function fmtDate(d) {
  if (!d) return ''
  const dt = typeof d === 'string' ? parseISO(d) : d
  if (!dt) return ''
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// Mirror of backend `generate_dates` — computes projected upcoming dates from
// the rule and applies exceptions (skips remove, reschedules substitute).
// Match the backend algorithm exactly so what we show equals what will be
// materialized on the next generate. `generate_weeks_ahead` bounds the window.
function computeUpcoming(schedule, exceptions, maxCount = 8) {
  if (!schedule) return []
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const window = Math.max(4, Math.min(52, schedule.generate_weeks_ahead || 8))
  const end = new Date(today); end.setDate(end.getDate() + 7 * window)

  const raw = []
  if (schedule.frequency === 'monthly') {
    const dom = schedule.day_of_month || 1
    let cur = new Date(today.getFullYear(), today.getMonth(), 1)
    while (cur <= end) {
      const target = new Date(cur.getFullYear(), cur.getMonth(), dom)
      if (target.getMonth() === cur.getMonth() && target >= today && target <= end) {
        raw.push(new Date(target))
      }
      cur.setMonth(cur.getMonth() + 1)
    }
  } else if (schedule.frequency === 'daily') {
    const step = Math.max(1, schedule.interval_weeks || 1)
    const chosen = (schedule.days_of_week && schedule.days_of_week.length)
      ? new Set(schedule.days_of_week) : null
    // Phase the N-day step off the anchor, not today, so it matches the backend
    // and doesn't shift on every render (step 1 is unaffected).
    const anchor = parseISO(schedule.anchor_date) || parseISO(schedule.series_start_date) || new Date(today)
    let cur = new Date(today)
    while (cur <= end) {
      const onStep = ((daysBetween(cur, anchor) % step) + step) % step === 0
      if (onStep && (!chosen || chosen.has(pyWeekday(cur)))) raw.push(new Date(cur))
      cur.setDate(cur.getDate() + 1)
    }
  } else {
    const days = (schedule.days_of_week && schedule.days_of_week.length)
      ? schedule.days_of_week : [schedule.day_of_week ?? 0]
    const interval = Math.max(1, schedule.interval_weeks || (schedule.frequency === 'biweekly' ? 2 : 1))
    // Count week-parity from a fixed anchor (matches backend generate_dates), so
    // biweekly stays biweekly instead of re-seating its phase off "today".
    let anchor = parseISO(schedule.anchor_date) || parseISO(schedule.series_start_date)
    if (!anchor) {
      // Brand-new series before its anchor is persisted: first upcoming occurrence.
      anchor = new Date(Math.min(...days.map(dow => {
        const c = new Date(today); c.setDate(c.getDate() + (((dow - pyWeekday(today)) + 7) % 7)); return c.getTime()
      })))
    }
    const refMonday = mondayOf(anchor)
    for (const dow of days) {
      const ahead = ((dow - pyWeekday(today)) + 7) % 7
      let cur = new Date(today); cur.setDate(cur.getDate() + ahead)
      while (cur <= end) {
        const weekIndex = Math.round(daysBetween(mondayOf(cur), refMonday) / 7)
        if (((weekIndex % interval) + interval) % interval === 0) raw.push(new Date(cur))
        cur.setDate(cur.getDate() + 7)
      }
    }
  }

  const skips = new Set()
  const adds = []
  for (const ex of exceptions || []) {
    if (ex.exception_date) skips.add(ex.exception_date)
    if (ex.exception_type === 'reschedule' && ex.rescheduled_date) {
      adds.push({ date: ex.rescheduled_date, start: ex.rescheduled_start_time, end: ex.rescheduled_end_time })
    }
  }

  const kept = raw
    .map(d => ({ date: isoDate(d), start: schedule.start_time, end: schedule.end_time, rescheduled: false }))
    .filter(x => !skips.has(x.date))

  const combined = [
    ...kept,
    ...adds.map(a => ({ date: a.date, start: a.start || schedule.start_time, end: a.end || schedule.end_time, rescheduled: true })),
  ]
  const seen = new Set()
  const dedup = []
  for (const x of combined.sort((a, b) => a.date.localeCompare(b.date))) {
    if (seen.has(x.date)) continue
    seen.add(x.date)
    dedup.push(x)
    if (dedup.length >= maxCount) break
  }
  return dedup
}

// ─── Skip modal ──────────────────────────────────────────────────────────
function SkipModal({ schedule, date, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setSaving(true); setError('')
    try {
      await post(`/api/recurring/${schedule.id}/skip`, {
        exception_date: date,
        reason: reason.trim() || null,
      })
      onDone()
    } catch (e) {
      setError(e.message || 'Failed to skip this visit')
      setSaving(false)
    }
  }
  return (
    <ModalShell title="Skip this visit" onClose={onClose}>
      <p className="text-sm text-ink-2">
        Cancel just the visit on <span className="font-semibold text-ink">{fmtDate(date)}</span>.
        Future visits on this recurring schedule are not affected.
      </p>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Reason (optional)</label>
        <input
          type="text" value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Client vacation, holiday, etc."
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm"
        />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Skipping…' : 'Skip this visit'}
        </Button>
      </div>
    </ModalShell>
  )
}

// ─── Reschedule modal ────────────────────────────────────────────────────
function RescheduleModal({ schedule, date, defaultStart, defaultEnd, onClose, onDone }) {
  const [newDate, setNewDate] = useState(date)
  const [start, setStart] = useState((defaultStart || '09:00').slice(0, 5))
  const [end, setEnd] = useState((defaultEnd || '11:00').slice(0, 5))
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!newDate) { setError('Pick a new date'); return }
    setSaving(true); setError('')
    try {
      await post(`/api/recurring/${schedule.id}/reschedule`, {
        exception_date: date,
        rescheduled_date: newDate,
        rescheduled_start_time: start + ':00',
        rescheduled_end_time: end + ':00',
        reason: reason.trim() || null,
      })
      onDone()
    } catch (e) {
      setError(e.message || 'Failed to reschedule this visit')
      setSaving(false)
    }
  }
  return (
    <ModalShell title="Reschedule this visit" onClose={onClose}>
      <p className="text-sm text-ink-2">
        Move the visit originally on <span className="font-semibold text-ink">{fmtDate(date)}</span>.
        Only this visit changes — future visits keep the recurring time.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">New date</label>
          <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Start</label>
          <input type="time" value={start} onChange={e => setStart(e.target.value)}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">End</label>
          <input type="time" value={end} onChange={e => setEnd(e.target.value)}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Reason (optional)</label>
        <input type="text" value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Client requested afternoon slot this week"
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Reschedule'}
        </Button>
      </div>
    </ModalShell>
  )
}

// ─── Edit-series modal (affects future visits) ───────────────────────────
function EditSeriesModal({ schedule, onClose, onDone }) {
  const [form, setForm] = useState({
    title: schedule.title || '',
    address: schedule.address || '',
    frequency: schedule.frequency || 'weekly',
    days_of_week: (schedule.days_of_week && schedule.days_of_week.length)
      ? schedule.days_of_week : [schedule.day_of_week ?? 0],
    day_of_month: schedule.day_of_month || 1,
    interval_weeks: schedule.interval_weeks || (schedule.frequency === 'biweekly' ? 2 : 1),
    start_time: (schedule.start_time || '09:00').slice(0, 5),
    end_time: (schedule.end_time || '11:00').slice(0, 5),
    generate_weeks_ahead: schedule.generate_weeks_ahead || 8,
    notes: schedule.notes || '',
    cleaner_ids: schedule.cleaner_ids || [],
    ends_mode: schedule.ends_mode || 'never',
    ends_on: schedule.ends_on || '',
    ends_after_count: schedule.series_end_occurrences || 10,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggleDay = (d) => setForm(f => {
    const has = f.days_of_week.includes(d)
    const next = has ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d].sort((a, b) => a - b)
    return { ...f, days_of_week: next }
  })
  const { employees } = useEmployees()
  const cleaners = useMemo(
    () => (employees || []).map(normalizeEmployee).filter(c => c.id),
    [employees]
  )
  const toggleCleaner = (id) => setForm(f => {
    const has = f.cleaner_ids.includes(id)
    const next = has ? f.cleaner_ids.filter(x => x !== id) : [...f.cleaner_ids, id]
    return { ...f, cleaner_ids: next }
  })
  const submit = async () => {
    if (!form.title.trim()) { setError('Title required'); return }
    if (!form.address.trim()) { setError('Address required'); return }
    if (form.frequency !== 'monthly' && form.days_of_week.length === 0) {
      setError('Pick at least one day of week'); return
    }
    if (form.ends_mode === 'on_date' && !form.ends_on) {
      setError('Pick an end date'); return
    }
    if (form.ends_mode === 'after_count' && (!form.ends_after_count || parseInt(form.ends_after_count) < 1)) {
      setError('Occurrence count must be at least 1'); return
    }
    setSaving(true); setError('')
    try {
      // Backend PATCH rejects `days_of_week: []` outright (would silently
      // collapse a multi-day schedule). For a monthly rule, days_of_week
      // is meaningless — omit it entirely so exclude_none drops it server-side.
      const payload = {
        title: form.title.trim(),
        address: form.address.trim(),
        frequency: form.frequency,
        // interval_weeks is the single source of cadence for week-based rules
        // (1=weekly, 2=biweekly, 4=every 4 weeks, 8=every 8 weeks…); the
        // backend ignores it for monthly. The Frequency select keeps it in sync.
        interval_weeks: parseInt(form.interval_weeks) || 1,
        day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
        start_time: form.start_time + ':00',
        end_time: form.end_time + ':00',
        generate_weeks_ahead: parseInt(form.generate_weeks_ahead) || 8,
        notes: form.notes || null,
        cleaner_ids: form.cleaner_ids,
        // Always send ends_mode (never omit) — update_schedule's PATCH
        // treats a missing key as "don't touch the existing end setting",
        // not "clear it", so the Ends UI must state its choice every save.
        ends_mode: form.ends_mode,
        ends_on: form.ends_mode === 'on_date' ? form.ends_on : null,
        ends_after_count: form.ends_mode === 'after_count' ? parseInt(form.ends_after_count) : null,
      }
      if (form.frequency !== 'monthly') {
        payload.days_of_week = form.days_of_week
      }
      await patch(`/api/recurring/${schedule.id}`, payload)
      onDone()
    } catch (e) {
      setError(e.message || 'Failed to save rule')
      setSaving(false)
    }
  }
  return (
    <ModalShell title="Edit recurring rule" onClose={onClose} wide>
      <div className="p-3 rounded-lg bg-panel border border-hairline text-ink-2 text-[13px] flex gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
        <div>
          <div className="font-semibold text-ink">These changes apply to future visits only.</div>
          Visits already on the calendar keep their current time and cleaners.
          To change one specific visit, use “Skip” or “Reschedule” on that row.
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Title</label>
        <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Address</label>
        <input type="text" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Frequency</label>
        <select
          value={form.frequency === 'monthly' ? 'monthly' : String(form.interval_weeks || (form.frequency === 'biweekly' ? 2 : 1))}
          onChange={e => {
            const v = e.target.value
            if (v === 'monthly') { setForm(f => ({ ...f, frequency: 'monthly' })); return }
            const n = parseInt(v) || 1
            setForm(f => ({ ...f, frequency: n === 2 ? 'biweekly' : 'weekly', interval_weeks: n }))
          }}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
          <option value="1">Weekly</option>
          <option value="2">Biweekly (every 2 weeks)</option>
          <option value="3">Every 3 weeks</option>
          <option value="4">Every 4 weeks</option>
          <option value="8">Every 8 weeks</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>
      {form.frequency === 'monthly' ? (
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Day of month (1–28)</label>
          <input type="number" min="1" max="28" value={form.day_of_month}
            onChange={e => setForm(f => ({ ...f, day_of_month: e.target.value }))}
            className="w-32 px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
      ) : (
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Day(s) of week</label>
          <div className="flex flex-wrap gap-2">
            {DAY_LABELS.map((lbl, i) => {
              const sel = form.days_of_week.includes(i)
              return (
                <button key={i} type="button" onClick={() => toggleDay(i)}
                  className={'px-3 py-1.5 rounded-full border text-sm ' + (sel
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-panel text-ink-2 border-hairline')}>
                  {lbl}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Start time</label>
          <input type="time" value={form.start_time}
            onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">End time</label>
          <input type="time" value={form.end_time}
            onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Crew</label>
        {cleaners.length === 0 ? (
          <p className="text-xs text-ink-3">No cleaners on the roster yet — add your crew on the Crew page.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cleaners.map(c => {
              const sel = form.cleaner_ids.includes(c.id)
              return (
                <button key={c.id} type="button" onClick={() => toggleCleaner(c.id)}
                  className={'px-3 py-1.5 rounded-full border text-sm ' + (sel
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-panel text-ink-2 border-hairline')}>
                  {c.name}
                </button>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-ink-3 mt-1.5">
          Changes future-generated visits only, same as the rest of this form —
          crew on visits already on the calendar is untouched.
        </p>
      </div>
      <EndsPicker
        value={{ ends_mode: form.ends_mode, ends_on: form.ends_on, ends_after_count: form.ends_after_count }}
        onChange={(next) => setForm(f => ({ ...f, ...next }))}
      />
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Keep visits scheduled ahead</label>
        <input type="number" min="1" max="52" value={form.generate_weeks_ahead}
          onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: e.target.value }))}
          className="w-32 px-3 py-2 border border-hairline rounded-lg text-sm" />
        <p className="text-xs text-ink-3 mt-1 max-w-md">
          How many weeks of visits are created at a time. With <b>Recurring auto-generate</b> on
          (Settings → Automation) this window rolls forward every day, so you never run out. It’s
          separate from how often the visit repeats above.
        </p>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Notes</label>
        <textarea value={form.notes} rows={2}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save rule changes'}
        </Button>
      </div>
    </ModalShell>
  )
}

// Shared modal chrome. Matches the fixed-overlay pattern used by JobCreateModal.
function ModalShell({ title, onClose, wide = false, children }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
      <div className={`w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[92dvh]`}>
        <div className="flex items-center justify-between bg-panel border-b border-hairline p-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="p-1.5 text-ink-3 hover:text-ink-2 hover:bg-bg-2 rounded" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain flex-1 p-4 sm:p-5 space-y-3">
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Series list row ─────────────────────────────────────────────────────
function SeriesRow({ s, clientName, onOpen, isDuplicate }) {
  const next = useMemo(() => {
    const up = computeUpcoming(s, [], 1)
    return up[0]?.date
  }, [s])
  const hasTime = !!s.start_time
  // Active-but-past-its-end-date (how split retires a predecessor: only
  // series_end_date is set, `active` stays true) reads as a quiet "Ended",
  // not as a live series.
  const live = isLiveSeries(s)
  return (
    <li>
      <button
        onClick={() => onOpen(s.id)}
        className="w-full text-left bg-panel border border-hairline rounded-2xl px-4 py-2.5 hover:bg-bg-2/60 transition"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="text-base font-semibold text-ink">{s.title || 'Untitled'}</h3>
              <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-gray-500'}`} />
                {SERIES_STATE_LABEL[seriesState(s)]}
              </span>
              {isDuplicate && (
                <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2"
                  title="Another live series for this client has the same property, cadence, and time on an overlapping day — likely a duplicate. Open both and pause or cancel one.">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Possible duplicate
                </span>
              )}
            </div>
            <p className="text-[13px] text-ink-2 truncate">
              {s.client_id ? (
                <Link to={`/clients/${s.client_id}`} onClick={e => e.stopPropagation()}
                  className="no-underline hover:text-indigo-600 hover:underline">
                  {clientName}
                </Link>
              ) : clientName}
              {' · '}{s.address}
            </p>
            <p className="text-[12px] text-ink-3 mt-1">
              {ruleSummary(s)}
              {hasTime
                ? <> · {fmtTime(s.start_time)}–{fmtTime(s.end_time)}</>
                : <> · <span className="text-amber-600 font-medium">no time set</span></>}
              {next && live && <> · Next {fmtDate(next)}</>}
              <> · {s.upcoming_job_count || 0} upcoming</>
            </p>
          </div>
          <span className="text-xs text-ink-3 self-center">Manage →</span>
        </div>
      </button>
    </li>
  )
}

// Duplicate grouping (same client + property + cadence + time, overlapping
// days, LIVE series only) lives in utils/recurringDuplicates.js —
// groupDuplicateSeries is THE single definition, shared by the list pills,
// the banner count, and the review panel below, and aligned with the
// backend's pre-create guard (services/recurring_guards.py).

// ─── Duplicate review panel ──────────────────────────────────────────────
// Groups "Possible duplicate" series side by side so the owner can pick the
// keeper and pause/cancel the others one confirmed action at a time. Drives
// ONLY the existing Manage endpoints — PATCH {active:false} (pause, same as
// the detail page's Pause button) and DELETE (soft-cancel: sets active=false;
// already-scheduled visits stay on the calendar, past visits untouched).
// Nothing is automatic: every action goes through the app's confirm dialog,
// and nothing is ever hard-deleted (scheduling-invariants R7).
function DuplicateReviewPanel({ schedules, clientsById, reviewedKeys, onToggleReviewed, onChanged, onClose }) {
  // Snapshot group membership (and the keeper suggestion) at open, so acting
  // on a series doesn't make its group vanish mid-review — the group stays
  // put and collapses to a quiet "Resolved" row once one active series is
  // left. Cards still render LIVE data from the schedules prop.
  const [groups] = useState(() =>
    // Live series only, day sets matched by OVERLAP — the shared definition
    // in groupDuplicateSeries (ended split-predecessors never show up here).
    groupDuplicateSeries(schedules).map(g => ({
      key: g.key,
      ids: g.members.map(s => s.id),
      suggestion: suggestKeeper(g.members),
    })))
  const byId = useMemo(() => {
    const m = {}
    schedules.forEach(s => { m[s.id] = s })
    return m
  }, [schedules])
  const [keeperByKey, setKeeperByKey] = useState({}) // group key → chosen keeper id
  const [actioned, setActioned] = useState({})       // series id → 'paused' | 'cancelled'
  const [busyId, setBusyId] = useState(null)

  const doPause = async (s) => {
    const ok = await confirmDialog(
      `Pause “${s.title || 'Untitled'}”?\n\nNo new visits will be generated while it's paused; visits already on the calendar stay. You can resume it anytime from Manage.`,
      { title: 'Pause series', confirmLabel: 'Pause series' },
    )
    if (!ok) return
    setBusyId(s.id)
    try {
      await patch(`/api/recurring/${s.id}`, { active: false })
      setActioned(a => ({ ...a, [s.id]: 'paused' }))
      toast.success('Series paused')
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Failed to pause series')
    } finally { setBusyId(null) }
  }

  const doCancel = async (s) => {
    const n = s.upcoming_job_count || 0
    const ok = await confirmDialog(
      `Cancel “${s.title || 'Untitled'}”?\n\nNo new visits will be generated for this series.`
      + (n > 0
        ? ` Its ${n} already-scheduled visit${n === 1 ? ' stays' : 's stay'} on the calendar until you remove them individually.`
        : '')
      + ` Past and completed visits are untouched.`,
      { title: 'Cancel series', confirmLabel: 'Cancel series', cancelLabel: 'Never mind', danger: true },
    )
    if (!ok) return
    setBusyId(s.id)
    try {
      await del(`/api/recurring/${s.id}`)
      setActioned(a => ({ ...a, [s.id]: 'cancelled' }))
      toast.success('Series cancelled')
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Failed to cancel series')
    } finally { setBusyId(null) }
  }

  return (
    <ModalShell title="Review duplicates" onClose={onClose} wide>
      <p className="text-[13px] text-ink-2">
        Each group below is the same client, property, cadence, and time on overlapping days. Pick the series to keep,
        then pause or cancel the extras — every action asks before it does anything, and
        visits already on the calendar are never touched.
      </p>
      {groups.length === 0 && (
        <EmptyState icon={Repeat} title="No duplicate groups"
          description="No two live series share a client, property, cadence, time, and day." compact />
      )}
      {groups.map(g => {
        const members = g.ids.map(id => byId[id]).filter(Boolean)
        const first = members[0]
        if (!first) return null
        const clientName = clientsById[first.client_id]?.name || 'Unknown client'
        const skipped = reviewedKeys.has(g.key)
        const activeMembers = members.filter(s => isLiveSeries(s) && !actioned[s.id])
        const keeperId = keeperByKey[g.key] ?? g.suggestion?.id

        if (skipped) {
          return (
            <div key={g.key}
              className="flex items-center gap-2 rounded-md border border-hairline bg-bg-2/50 px-3 py-2 text-[12px] text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400 shrink-0" />
              <span className="min-w-0 truncate">
                Skipped — not duplicates · {clientName} · {ruleSummary(first)}
              </span>
              <button onClick={() => onToggleReviewed(g.key)}
                className="ml-auto shrink-0 font-medium text-ink-2 hover:text-ink underline underline-offset-2">
                Undo
              </button>
            </div>
          )
        }

        if (activeMembers.length <= 1) {
          const kept = activeMembers[0]
          return (
            <div key={g.key}
              className="flex items-center gap-2 rounded-md border border-hairline bg-bg-2/50 px-3 py-2 text-[12px] text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span className="min-w-0 truncate">
                Resolved · {clientName} · {ruleSummary(first)}
                {kept ? <> — keeping “{kept.title || 'Untitled'}”</> : ' — no active series left'}
              </span>
            </div>
          )
        }

        return (
          <section key={g.key} className="rounded-md border border-hairline bg-bg-2/40 p-3">
            <header className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="text-sm font-semibold text-ink min-w-0">
                {clientName}
                <span className="font-normal text-ink-3"> · {ruleSummary(first)}</span>
              </div>
              <button onClick={() => onToggleReviewed(g.key)}
                className="shrink-0 text-[12px] text-ink-3 hover:text-ink underline underline-offset-2">
                Not duplicates — skip this group
              </button>
            </header>
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
              {members.map(s => {
                const state = actioned[s.id]
                  || seriesState(s)
                const isKeeper = state === 'active' && s.id === keeperId
                const suggested = g.suggestion?.id === s.id
                const next = state === 'active' ? computeUpcoming(s, [], 1)[0]?.date : null
                return (
                  <div key={s.id}
                    className={`rounded-md border bg-panel p-3 ${isKeeper ? 'border-emerald-300 dark:border-emerald-800' : 'border-hairline'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink truncate">{s.title || 'Untitled'}</div>
                        <div className="text-[12px] text-ink-2 truncate">
                          {s.client_id ? (
                            <Link to={`/clients/${s.client_id}`}
                              className="no-underline hover:text-indigo-600 hover:underline">
                              {clientsById[s.client_id]?.name || `Client #${s.client_id}`}
                            </Link>
                          ) : 'No client'}
                          {' · '}{s.address}
                        </div>
                      </div>
                      <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 shrink-0">
                        <span className={`h-1.5 w-1.5 rounded-full ${
                          state === 'active' ? 'bg-emerald-500'
                          : state === 'cancelled' ? 'bg-red-500' : 'bg-gray-500'}`} />
                        {state === 'active' ? 'Active'
                          : state === 'cancelled' ? 'Cancelled'
                          : SERIES_STATE_LABEL[state] || 'Paused'}
                      </span>
                    </div>
                    <div className="mt-2 space-y-0.5 text-[12px] text-ink-3">
                      <div>{ruleSummary(s)} · {s.start_time
                        ? <>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</>
                        : <span className="text-amber-600 font-medium">no time set</span>}</div>
                      <div>Created {fmtDate((s.created_at || '').slice(0, 10)) || 'unknown'}</div>
                      <div>
                        {s.upcoming_job_count || 0} upcoming visit{(s.upcoming_job_count || 0) === 1 ? '' : 's'}
                        {next && <> · next {fmtDate(next)}</>}
                      </div>
                    </div>
                    {state === 'active' ? (
                      isKeeper ? (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-emerald-300 dark:border-emerald-800 bg-panel px-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            Keeper
                          </span>
                          {suggested && (
                            <span className="text-[11px] text-ink-3">Suggested — {g.suggestion.reason}</span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <button onClick={() => setKeeperByKey(m => ({ ...m, [g.key]: s.id }))}
                            className="inline-flex items-center rounded-md border border-hairline bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 hover:text-ink">
                            Keep this one
                          </button>
                          <span className="ml-auto inline-flex items-center gap-2">
                            <Button variant="secondary" size="sm" disabled={busyId === s.id}
                              onClick={() => doPause(s)}>
                              <Pause className="w-3.5 h-3.5 mr-1" />Pause
                            </Button>
                            <button onClick={() => doCancel(s)} disabled={busyId === s.id}
                              className="inline-flex items-center rounded-md border border-hairline bg-panel px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed">
                              Cancel series
                            </button>
                          </span>
                        </div>
                      )
                    ) : (
                      <div className="mt-3 text-[11px] text-ink-3">
                        {state === 'cancelled'
                          ? 'Cancelled — no new visits will be generated.'
                          : state === 'ended'
                            ? 'Ended — this series reached its end date; no new visits are generated.'
                            : state === 'cancelled'
                              ? 'Cancelled — no new visits. Visits already on the calendar stay until you remove them.'
                              : 'Paused — no new visits while paused; resume anytime from Manage.'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
      <div className="flex justify-end pt-2">
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    </ModalShell>
  )
}

// ─── Detail view ─────────────────────────────────────────────────────────
function SeriesDetail({ id, onBack, onChanged, toast }) {
  const [schedule, setSchedule] = useState(null)
  const [exceptions, setExceptions] = useState([])
  const [client, setClient] = useState(null)
  const [generatedDates, setGeneratedDates] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // 'pause' | 'generate' | 'delete'
  const [modal, setModal] = useState(null) // { kind: 'skip'|'reschedule'|'edit', date, start, end }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [sch, exs, jobs] = await Promise.all([
        get(`/api/recurring/${id}`),
        get(`/api/recurring/${id}/exceptions`).catch(() => []),
        // Real materialized Jobs for this series — the rule projection below
        // (computeUpcoming) shows what SHOULD happen per the recurrence rule,
        // which can outrun what's actually been generated. Without this, the
        // detail page confidently listed dates that had no Job row yet, while
        // the series list's "N upcoming" (a real Job count) correctly said 0.
        get(`/api/jobs?recurring_schedule_id=${id}&status=scheduled&limit=200`).catch(() => []),
      ])
      setSchedule(sch)
      setExceptions(Array.isArray(exs) ? exs : [])
      setGeneratedDates(new Set(
        (Array.isArray(jobs) ? jobs : [])
          .map(j => (j.scheduled_date || '').slice(0, 10))
          .filter(Boolean)
      ))
      if (sch?.client_id) {
        const c = await get(`/api/clients/${sch.client_id}`).catch(() => null)
        setClient(c)
      }
    } catch (e) {
      setError(e.message || 'Failed to load recurring series')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const upcoming = useMemo(
    () => (schedule ? computeUpcoming(schedule, exceptions, 8) : []),
    [schedule, exceptions],
  )
  const generatedCount = upcoming.filter(u => generatedDates.has(u.date)).length

  const togglePause = async () => {
    if (!schedule) return
    setBusy('pause')
    try {
      await patch(`/api/recurring/${id}`, { active: !schedule.active })
      await load(); onChanged?.()
      toast.success(schedule.active ? 'Series paused' : 'Series resumed')
    } catch (e) {
      toast.error(e.message || 'Failed to update')
    } finally { setBusy('') }
  }
  const regenerate = async () => {
    setBusy('generate')
    try {
      const r = await post(`/api/recurring/${id}/generate`, {})
      await load(); onChanged?.()
      toast.success(`Materialized ${r.jobs_created || 0} new job${r.jobs_created === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error(e.message || 'Generation failed')
    } finally { setBusy('') }
  }
  const cancelSeries = async () => {
    if (!(await confirmDialog('Cancel this recurring series? Existing scheduled jobs stay on the calendar; no new ones will be generated.', { confirmLabel: 'Cancel series', cancelLabel: 'Never mind', danger: true }))) return
    setBusy('delete')
    try {
      await del(`/api/recurring/${id}`)
      toast.success('Series cancelled')
      onBack()
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Cancel failed')
      setBusy('')
    }
  }
  const undoException = async (ex) => {
    if (!(await confirmDialog(`Undo the ${ex.exception_type} on ${ex.exception_date}?`, { confirmLabel: 'Undo' }))) return
    try {
      await del(`/api/recurring/${id}/exceptions/${ex.id}`)
      await load(); onChanged?.()
      toast.success('Override removed')
    } catch (e) {
      toast.error(e.message || 'Undo failed')
    }
  }

  if (loading) return <div className="p-6 text-sm text-ink-3">Loading…</div>
  if (error) return (
    <div className="p-6">
      <ErrorNote>{error}</ErrorNote>
      <Button variant="secondary" onClick={onBack} className="mt-4">Back to list</Button>
    </div>
  )
  if (!schedule) return null

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> All recurring series
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl sm:text-2xl font-bold text-ink">{schedule.title || 'Untitled'}</h1>
            <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${isLiveSeries(schedule) ? 'bg-emerald-500' : 'bg-gray-500'}`} />
              {SERIES_STATE_LABEL[seriesState(schedule)]}
            </span>
          </div>
          <p className="text-sm text-ink-2">
            {client
              ? <Link to={`/clients/${client.id}`} className="hover:underline">{client.name}</Link>
              : schedule.client_id
                ? <Link to={`/clients/${schedule.client_id}`} className="hover:underline">{`Client #${schedule.client_id}`}</Link>
                : 'No client'}
            {' · '}{schedule.address}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={togglePause} disabled={busy === 'pause'}>
            {schedule.active
              ? <><Pause className="w-4 h-4 mr-1" />Pause</>
              : <><Play className="w-4 h-4 mr-1" />Resume</>}
          </Button>
          <Button variant="primary" size="sm" onClick={regenerate}
            disabled={!schedule.active || busy === 'generate'}>
            <RefreshCw className={`w-4 h-4 mr-1 ${busy === 'generate' ? 'animate-spin' : ''}`} />
            {busy === 'generate' ? 'Generating…' : 'Generate now'}
          </Button>
        </div>
      </div>

      {/* Rule summary + edit-future */}
      <GlassCard className="p-4 mt-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-1">Recurring rule</div>
            <div className="text-[15px] text-ink font-medium">{ruleSummary(schedule)}</div>
            <div className="text-sm text-ink-2 mt-0.5">
              {fmtTime(schedule.start_time)} – {fmtTime(schedule.end_time)}
              {schedule.generate_weeks_ahead ? ` · generates ${schedule.generate_weeks_ahead} weeks ahead` : ''}
              {' · '}{endsSummary(schedule)}
            </div>
            {schedule.notes && <div className="text-[13px] text-ink-3 mt-2 italic">{schedule.notes}</div>}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'edit' })}>
            <Pencil className="w-4 h-4 mr-1" /> Edit rule (future visits)
          </Button>
        </div>
      </GlassCard>

      {/* Upcoming visits */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-ink">Upcoming visits</h2>
          <span className="text-xs text-ink-3">
            Skip or reschedule affects only that one visit
          </span>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState
            icon={Calendar}
            title="No upcoming visits"
            description={schedule.active
              ? 'Try widening the rule or generating jobs.'
              : 'Series is paused — no visits are being scheduled.'}
            compact
          />
        ) : (
          <>
            {generatedCount < upcoming.length && (
              <div className="mb-2 flex items-start gap-2 text-xs text-ink-2 bg-panel border border-hairline rounded-lg px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
                <span>
                Only {generatedCount} of these {upcoming.length} dates {generatedCount === 1 ? 'has' : 'have'} an
                actual job on the Schedule — the rest are projected from the rule but haven't been generated yet.
                Use "Generate now" above to materialize them.
                </span>
              </div>
            )}
            <ul className="space-y-1.5">
            {upcoming.map((u) => (
              <li key={u.date}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border bg-panel border-hairline">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">
                    {fmtDate(u.date)}
                    {u.rescheduled && (
                      <span className="ml-2 inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        rescheduled
                      </span>
                    )}
                    {!generatedDates.has(u.date) && (
                      <span className="ml-2 inline-flex items-center gap-1.5 text-[10px] font-medium text-ink-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-ink-3/40 shrink-0" aria-hidden="true" />
                        not yet generated
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-3">
                    {fmtTime(u.start)} – {fmtTime(u.end)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="secondary" size="sm"
                    onClick={() => setModal({ kind: 'skip', date: u.date })}>
                    <SkipForward className="w-3.5 h-3.5 mr-1" /> Skip
                  </Button>
                  <Button variant="secondary" size="sm"
                    onClick={() => setModal({ kind: 'reschedule', date: u.date, start: u.start, end: u.end })}>
                    <Clock className="w-3.5 h-3.5 mr-1" /> Reschedule
                  </Button>
                </div>
              </li>
            ))}
            </ul>
          </>
        )}
      </div>

      {/* Exceptions log */}
      {exceptions.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-ink mb-2">Overrides history</h2>
          <ul className="space-y-1.5">
            {exceptions
              .slice()
              .sort((a, b) => (b.exception_date || '').localeCompare(a.exception_date || ''))
              .map((ex) => (
              <li key={ex.id}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-panel border border-hairline">
                <div className="min-w-0 text-sm">
                  <div>
                    <span className="font-semibold text-ink capitalize">{ex.exception_type}</span>
                    {' '}on{' '}
                    <span className="text-ink-2">{fmtDate(ex.exception_date)}</span>
                    {ex.exception_type === 'reschedule' && ex.rescheduled_date && (
                      <> → <span className="text-ink-2">{fmtDate(ex.rescheduled_date)}</span></>
                    )}
                  </div>
                  {ex.reason && <div className="text-xs text-ink-3 mt-0.5">{ex.reason}</div>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => undoException(ex)}>
                  <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Danger zone */}
      <div className="mt-8 pt-5 border-t border-hairline">
        <h2 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">Danger zone</h2>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-ink-3">
            Cancels the series so no new jobs are generated.
            Already-scheduled jobs remain on the calendar until you delete them individually.
          </p>
          <Button variant="secondary" size="sm" onClick={cancelSeries} disabled={busy === 'delete'}>
            Cancel series
          </Button>
        </div>
      </div>

      {modal?.kind === 'skip' && (
        <SkipModal
          schedule={schedule} date={modal.date}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Visit skipped') }}
        />
      )}
      {modal?.kind === 'reschedule' && (
        <RescheduleModal
          schedule={schedule} date={modal.date}
          defaultStart={modal.start} defaultEnd={modal.end}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Visit rescheduled') }}
        />
      )}
      {modal?.kind === 'edit' && (
        <EditSeriesModal
          schedule={schedule}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Rule updated for future visits') }}
        />
      )}
    </div>
  )
}

// ─── Root page ───────────────────────────────────────────────────────────
// ─── Recurring Doctor: health-scan panel ─────────────────────────────────
// Renders GET /api/recurring/cleanup/health (read-only server audit) and
// offers the one-tap fix per problem code. Every fix goes through the normal
// endpoints and asks first; destructive ones get the danger confirm.
const SEVERITY_DOT = { error: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-gray-400' }

function HealthPanel({ onClose, onChanged, onOpenSeries, onOpenDuplicates, onCleanupOffPhase, cleaningOffPhase }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  const scan = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const next = await get('/api/recurring/cleanup/health')
      setReport(next)
      return next
    } catch (e) {
      setError(e.message || 'Health scan failed')
      return null
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { scan() }, [scan])

  const act = async (issue, fn, doneMsg) => {
    setBusyId(issue.schedule_id)
    try {
      await fn()
      if (doneMsg) toast.success(doneMsg)
      onChanged?.()
      await scan()
    } catch (e) {
      toast.error(e.message || 'That fix failed')
    } finally {
      setBusyId(null)
    }
  }

  // One primary fix per problem code (the scan's `suggestion` is the label's
  // tooltip). Rename is computed here from client + cadence rather than parsed
  // out of the suggestion string.
  const fixFor = (issue, prob) => {
    const id = issue.schedule_id
    switch (prob.code) {
      case 'junk_title': {
        const better = issue.client_name ? `${issue.client_name} — ${issue.cadence}` : issue.cadence
        return { short: `Rename to “${better}”`, run: () => act(issue, async () => {
          await patch(`/api/recurring/${id}`, { title: better })
        }, 'Renamed') }
      }
      case 'ended_but_active':
        return { short: 'Mark ended', run: () => act(issue, async () => {
          await patch(`/api/recurring/${id}`, { active: false })
        }, 'Marked ended — history kept') }
      case 'active_no_upcoming':
        return { short: 'Generate visits', run: () => act(issue, async () => {
          const r = await post(`/api/recurring/${id}/generate`)
          toast.success(`Generated ${r?.created ?? r?.generated ?? ''} visits`.replace('  ', ' '))
        }) }
      case 'stale_paused':
        return { short: 'Cancel series', danger: true, run: async () => {
          const ok = await confirmDialog(
            `Cancel “${issue.title || 'Untitled'}” for ${issue.client_name || 'this client'}? ` +
            'It disappears from this list; completed visits and history are kept. It cannot be resumed.',
            { title: 'Cancel series?', confirmLabel: 'Cancel series', danger: true },
          )
          if (!ok) return
          act(issue, () => del(`/api/recurring/${id}`), 'Series cancelled')
        } }
      case 'duplicate':
        return { short: 'Review duplicates', run: () => { onClose(); onOpenDuplicates() } }
      default:
        return { short: 'Open series', run: () => { onClose(); onOpenSeries(id) } }
    }
  }

  // ── Fix-all, for the codes where the fix is identical and reversible ──────
  // Which codes qualify, and why the dangerous ones don't, lives in
  // utils/recurringBulk.js — that decision is about writing to a live book of
  // business, so it's tested on its own rather than buried in this screen.
  const [bulkBusy, setBulkBusy] = useState(null)
  const groups = groupBulkable(report?.issues)

  const runBulk = async ({ code, cfg, list }) => {
    const ok = await confirmDialog(describeBatch(cfg, list), {
      title: `${cfg.verb}?`, confirmLabel: `${cfg.verb} (${list.length})`,
    })
    if (!ok) return

    setBulkBusy(code)
    const before = report.issues.length
    const { done, failed } = await applyBatch(list, (issue) =>
      patch(`/api/recurring/${issue.schedule_id}`, cfg.body(issue)))
    setBulkBusy(null)

    onChanged?.()
    const after = await scan()
    if (failed.length) {
      toast.error(`Fixed ${done} of ${list.length} — ${failed.length} failed: ${failed.slice(0, 3).join(', ')}`)
    } else {
      // Before/after: "12 fixed" means nothing without the remainder.
      toast.success(
        `Fixed ${done} · ${before} series needed attention, ${after?.issues?.length ?? '?'} still do`)
    }
  }

  return (
    <ModalShell title="Recurring health check" onClose={onClose} wide>
      {loading ? (
        <div className="text-center text-ink-3 py-10 text-sm">Scanning every series…</div>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-[13px] text-ink-2 flex-1 min-w-0">
              Scanned <b className="text-ink">{report.scanned}</b> series —{' '}
              <b className="text-ink">{report.healthy}</b> healthy,{' '}
              <b className="text-ink">{report.issues.length}</b> need{report.issues.length === 1 ? 's' : ''} attention.
              Nothing below changes without your confirm.
            </p>
            {onCleanupOffPhase && (
              <button
                onClick={onCleanupOffPhase}
                disabled={cleaningOffPhase}
                title="Separately check for off-cadence duplicate VISITS left by the old biweekly-drift bug — a different check from the schedule-level duplicates above"
                className="shrink-0 text-[12px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink-2 disabled:opacity-50">
                {cleaningOffPhase ? 'Checking off-cadence visits…' : 'Also check off-cadence visits'}
              </button>
            )}
          </div>
          {groups.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-hairline bg-bg-2/40 px-3 py-2">
              <span className="text-[12px] text-ink-3">Same fix, several series:</span>
              {groups.map(g => (
                <button key={g.code} onClick={() => runBulk(g)}
                  disabled={!!bulkBusy}
                  data-testid={`bulk-${g.code}`}
                  className="text-[12px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-50">
                  {bulkBusy === g.code
                    ? `Fixing ${g.list.length}…`
                    : `${g.cfg.verb} (${g.list.length} ${g.cfg.label})`}
                </button>
              ))}
            </div>
          )}

          {report.issues.length === 0 && (
            <EmptyState icon={Repeat} title="All series healthy"
              description="No duplicates, ghosts, or broken links found." compact />
          )}
          {report.issues.map(issue => (
            <section key={issue.schedule_id} className="rounded-md border border-hairline bg-bg-2/40 p-3">
              <header className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="text-sm font-semibold text-ink min-w-0 truncate">
                  {issue.title || 'Untitled'}
                  <span className="font-normal text-ink-3"> · {issue.client_name || 'Unknown client'} · {issue.cadence}</span>
                </div>
                <span className="shrink-0 text-[12px] text-ink-3">
                  {issue.upcoming_job_count} upcoming
                </span>
              </header>
              <ul className="mt-2 space-y-1.5">
                {issue.problems.map(prob => {
                  const fix = fixFor(issue, prob)
                  return (
                    <li key={prob.code} className="flex items-start gap-2 text-[13px] text-ink-2">
                      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[prob.severity] || 'bg-gray-400'}`} />
                      <span className="min-w-0 flex-1" title={prob.suggestion}>{prob.message}</span>
                      <button
                        onClick={fix.run}
                        disabled={busyId === issue.schedule_id}
                        className={`shrink-0 text-[12px] font-medium underline underline-offset-2 disabled:opacity-50 ${
                          fix.danger ? 'text-red-600 hover:text-red-700' : 'text-ink-2 hover:text-ink'
                        }`}>
                        {fix.short}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </ModalShell>
  )
}


export default function Recurring() {
  const [params, setParams] = useSearchParams()
  const seriesId = params.get('series')

  const [schedules, setSchedules] = useState([])
  const [clientsById, setClientsById] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterClient, setFilterClient] = useState('')
  // Opens on the live book of business. It used to open on 'all', so a series
  // you cancelled stayed on the screen you landed on — which is most of why
  // cancelling read as "it didn't work". Retired series are one chip away.
  const [filterStatus, setFilterStatus] = useState('active')
  const [showCreate, setShowCreate] = useState(false)

  // Surface the one setting that makes recurring "run dry": if auto-generate is
  // OFF, the schedules do a one-time fill and never roll forward. Warn loudly so
  // the operator isn't left wondering why upcoming visits stop appearing.
  const [autoGenOff, setAutoGenOff] = useState(false)
  useEffect(() => {
    get('/api/settings/automation')
      .then(s => setAutoGenOff(s?.recurring_auto_generate_enabled === false))
      .catch(() => setAutoGenOff(false)) // stay quiet if we can't tell
  }, [])

  const loadList = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [sch, cli] = await Promise.all([
        get('/api/recurring'),
        // T-06: preload up to 1000 so schedule → client-name resolution and
        // the filter dropdown cover the whole book, not just the first 50.
        get('/api/clients?limit=1000').catch(() => []),
      ])
      const cliArr = Array.isArray(cli) ? cli : (cli.items || [])
      const map = {}; cliArr.forEach(c => { map[c.id] = c })
      setSchedules(Array.isArray(sch) ? sch : (sch.items || []))
      setClientsById(map)
    } catch (e) {
      setError(e.message || 'Failed to load recurring schedules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  const [cleaning, setCleaning] = useState(false)
  // One-time maintenance: find + remove the off-cadence duplicate visits the
  // old biweekly-drift bug created. Always previews (dry-run) and asks before
  // cancelling anything.
  const cleanupDuplicates = useCallback(async () => {
    setCleaning(true)
    try {
      const preview = await get('/api/recurring/cleanup/off-phase-preview')
      const items = preview?.candidates || []
      if (!items.length) {
        toast.success('No off-cadence duplicate visits found — your recurring schedule is clean.')
        return
      }
      const sample = items.slice(0, 6).map(c => `• ${c.scheduled_date} — ${c.title}`).join('\n')
      const more = items.length > 6 ? `\n…and ${items.length - 6} more` : ''
      const ok = await confirmDialog(
        `Found ${items.length} future visit${items.length === 1 ? '' : 's'} on the wrong week (leftovers from the old biweekly bug):\n\n${sample}${more}\n\nCancel them? Their Google Calendar events are removed too. Past and completed visits are never touched.`,
        { confirmLabel: `Cancel ${items.length} duplicate${items.length === 1 ? '' : 's'}`, cancelLabel: 'Keep them', danger: true },
      )
      if (!ok) return
      const res = await post('/api/recurring/cleanup/off-phase-apply', {})
      toast.success(`Removed ${res?.cancelled_count ?? 0} duplicate visit${res?.cancelled_count === 1 ? '' : 's'}.`)
      loadList()
    } catch (e) {
      toast.error(e.message || 'Cleanup failed')
    } finally {
      setCleaning(false)
    }
  }, [loadList])

  // JobCreateModal loads properties itself, scoped to whichever client gets
  // picked inside it — no page-level preload needed (the old RecurringCreateModal
  // required properties up front for its own picker; this modal doesn't).
  const openCreate = useCallback(() => setShowCreate(true), [])

  const openSeries = (id) => setParams({ series: String(id) })
  const backToList = () => setParams({})

  const filtered = useMemo(() => {
    return schedules.filter(s => {
      // "Active" means LIVE (active and not past its end date); an active row
      // whose series_end_date has passed — how split retires a predecessor —
      // is "Ended", its own quiet state, so retired series stop reading as
      // live. The `active` column itself is untouched (display-only).
      // One shared verdict per series (seriesState) rather than three hand-
      // rolled predicates that could disagree with the chip the row displays.
      if (filterStatus !== 'all' && seriesState(s) !== filterStatus) return false
      if (filterClient && String(s.client_id) !== String(filterClient)) return false
      return true
    })
  }, [schedules, filterClient, filterStatus])

  const clientOptions = useMemo(
    () => Object.values(clientsById).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [clientsById],
  )

  // Duplicate groups among LIVE series (shared definition with the backend
  // pre-create guard: same client + property + cadence + time, overlapping
  // days). Ended series never count, so retired split-predecessors stop
  // flooding the flag.
  const dupGroups = useMemo(() => groupDuplicateSeries(schedules), [schedules])
  const dupKeyBySeriesId = useMemo(() => {
    const m = new Map()
    for (const g of dupGroups) for (const s of g.members) m.set(s.id, g.key)
    return m
  }, [dupGroups])

  // Review-duplicates panel: opened from the banner; groups the flagged
  // series so the owner picks a keeper and confirms each pause/cancel.
  // "Skip this group" (false positive) persists per-group in localStorage so
  // the banner count and pills stop nagging about it.
  const [reviewOpen, setReviewOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [reviewedKeys, setReviewedKeys] = useState(() => loadReviewedDupKeys())
  const toggleReviewed = useCallback((key) => {
    setReviewedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveReviewedDupKeys(next)
      return next
    })
  }, [])
  const dupGroupCount = useMemo(
    () => dupGroups.filter(g => !reviewedKeys.has(g.key)).length,
    [dupGroups, reviewedKeys],
  )

  // Detail view
  if (seriesId) {
    return (
      <>
        <SeriesDetail
          id={seriesId}
          onBack={backToList}
          onChanged={loadList}
          toast={toast}
        />
      </>
    )
  }

  // List view
  return (
    <>
      <PageHeader
        title="Recurring bookings"
        subtitle="Weekly and biweekly cleans. Change one visit without disturbing future ones."
        icon={Repeat}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={loadList}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setHealthOpen(true)}
              title="Scan every series for duplicates, ghosts, missing times, and broken links">
              <AlertTriangle className="w-4 h-4 mr-1" /> Health check
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1" /> New series
            </Button>
          </>
        }
      >
        <SubNav />
      </PageHeader>

      <div className="max-w-5xl mx-auto px-4 sm:px-8 pb-8">
        {autoGenOff && (
          <div className="mt-4 mb-4 flex items-start gap-2.5 rounded-lg bg-panel border border-hairline px-3.5 py-3 text-sm text-ink-2">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
            <div>
              <p className="font-semibold text-ink">Recurring auto-generate is off</p>
              <p className="text-[13px] mt-0.5 text-ink-3">
                Schedules were filled once and won’t roll forward, so upcoming visits will stop
                appearing over time. Turn on <b>Recurring auto-generate</b> in Settings → General
                to keep the window topped up automatically.
              </p>
              <a href="/settings#general"
                className="inline-block mt-1.5 text-[13px] font-semibold underline underline-offset-2 hover:opacity-80">
                Open Settings → General
              </a>
            </div>
          </div>
        )}
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <select
            value={filterClient}
            onChange={e => setFilterClient(e.target.value)}
            className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
          >
            <option value="">All clients</option>
            {clientOptions.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1 bg-panel border border-hairline rounded-lg p-0.5">
            {[
              { v: 'active', label: 'Active' },
              { v: 'paused', label: 'Paused' },
              { v: 'cancelled', label: 'Cancelled' },
              { v: 'ended', label: 'Ended' },
              { v: 'all', label: 'All' },
            ].map(o => (
              <button key={o.v}
                onClick={() => setFilterStatus(o.v)}
                aria-pressed={filterStatus === o.v}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  filterStatus === o.v ? 'bg-bg-2 text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
                }`}>
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-ink-3 ml-auto">
            {filtered.length} of {schedules.length}
          </span>
        </div>

        {dupGroupCount > 0 && (
          <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 rounded-xl bg-panel border border-hairline text-ink-2 text-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              {dupGroupCount} possible duplicate group{dupGroupCount === 1 ? '' : 's'} — same client,
              property, cadence, and time on overlapping days. Review them side by side and pick
              which series to keep; nothing is changed automatically.
            </span>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setReviewOpen(true)}>
              Review
            </Button>
          </div>
        )}

        <ErrorNote className="mb-3">{error}</ErrorNote>

        {loading ? (
          <div className="text-center text-ink-3 py-12 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title={schedules.length === 0 ? 'No recurring series yet' : 'Nothing matches your filters'}
            description={schedules.length === 0
              ? 'Create one here, from a client, or from a signed quote.'
              : 'Try clearing the client or status filter.'}
            action={schedules.length === 0
              ? <Button variant="primary" size="sm" onClick={openCreate}>
                  <Plus className="w-4 h-4 mr-1" />New series
                </Button>
              : null}
          />
        ) : (
          <ul className="space-y-2.5">
            {filtered.map(s => (
              <SeriesRow
                key={s.id}
                s={s}
                clientName={clientsById[s.client_id]?.name || 'Unknown client'}
                onOpen={openSeries}
                isDuplicate={dupKeyBySeriesId.has(s.id) && !reviewedKeys.has(dupKeyBySeriesId.get(s.id))}
              />
            ))}
          </ul>
        )}
      </div>
      {healthOpen && (
        <HealthPanel
          onClose={() => setHealthOpen(false)}
          onChanged={loadList}
          onOpenSeries={openSeries}
          onOpenDuplicates={() => setReviewOpen(true)}
          onCleanupOffPhase={cleanupDuplicates}
          cleaningOffPhase={cleaning}
        />
      )}
      {reviewOpen && (
        <DuplicateReviewPanel
          schedules={schedules}
          clientsById={clientsById}
          reviewedKeys={reviewedKeys}
          onToggleReviewed={toggleReviewed}
          onChanged={loadList}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {showCreate && (
        <JobCreateModal
          defaultRecurring
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadList() }}
        />
      )}
    </>
  )
}
