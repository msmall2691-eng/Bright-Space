import { useState, useEffect, useMemo, useCallback } from 'react'
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
import { useToast } from '../components/ui/Toast'
import { useEmployees } from '../hooks/useEmployees'
import EndsPicker from '../components/schedule/EndsPicker'

/** Resolve a Connecteam employee to an id+name pair, defensively. Mirrors
 *  JobEditModal's normalizeEmployee — Connecteam returns shapes like
 *  { userId, firstName, lastName, displayName } or sometimes { id, name }. */
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
    let cur = new Date(today)
    while (cur <= end) {
      if (!chosen || chosen.has(pyWeekday(cur))) raw.push(new Date(cur))
      cur.setDate(cur.getDate() + step)
    }
  } else {
    const days = (schedule.days_of_week && schedule.days_of_week.length)
      ? schedule.days_of_week : [schedule.day_of_week ?? 0]
    const interval = Math.max(1, schedule.interval_weeks || (schedule.frequency === 'biweekly' ? 2 : 1))
    for (const dow of days) {
      const ahead = ((dow - pyWeekday(today)) + 7) % 7
      let cur = new Date(today); cur.setDate(cur.getDate() + ahead)
      while (cur <= end) {
        raw.push(new Date(cur))
        cur.setDate(cur.getDate() + 7 * interval)
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
      {error && <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}
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
      {error && <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}
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
        interval_weeks: form.frequency === 'biweekly' ? 2
          : form.frequency === 'weekly' ? 1
          : parseInt(form.interval_weeks) || 1,
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
      <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-[13px] flex gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold">These changes apply to future visits only.</div>
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
        <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
          <option value="weekly">Weekly</option>
          <option value="biweekly">Biweekly (every 2 weeks)</option>
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
                    ? 'bg-blue-600 text-white border-blue-600'
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
          <p className="text-xs text-ink-3">No cleaners returned from Connecteam.</p>
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
        <label className="block text-xs font-semibold text-ink-3 mb-1">Generate weeks ahead</label>
        <input type="number" min="1" max="52" value={form.generate_weeks_ahead}
          onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: e.target.value }))}
          className="w-32 px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Notes</label>
        <textarea value={form.notes} rows={2}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      {error && <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save rule changes'}
        </Button>
      </div>
    </ModalShell>
  )
}

// Shared modal chrome. Matches the fixed-overlay pattern used by
// RecurringCreateModal and JobCreateModal.
function ModalShell({ title, onClose, wide = false, children }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
      <div className={`w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[95vh]`}>
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-blue-600 p-4 text-white">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-blue-400 rounded" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 sm:p-5 space-y-3">
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Series list row ─────────────────────────────────────────────────────
function SeriesRow({ s, clientName, onOpen }) {
  const next = useMemo(() => {
    const up = computeUpcoming(s, [], 1)
    return up[0]?.date
  }, [s])
  return (
    <li>
      <button
        onClick={() => onOpen(s.id)}
        className="w-full text-left bg-panel border border-hairline rounded-2xl p-4 hover:border-blue-400 hover:shadow-sm transition"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-semibold text-ink">{s.title || 'Untitled'}</h3>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.active
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-bg-2 text-ink-3'}`}>
                {s.active ? 'Active' : 'Paused'}
              </span>
            </div>
            <p className="text-[13px] text-ink-2 truncate">{clientName} · {s.address}</p>
            <p className="text-[12px] text-ink-3 mt-1">
              {ruleSummary(s)} · {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
              {next && s.active && <> · Next {fmtDate(next)}</>}
              <> · {s.upcoming_job_count || 0} upcoming</>
            </p>
          </div>
          <span className="text-xs text-ink-3 self-center">Manage →</span>
        </div>
      </button>
    </li>
  )
}

// ─── Detail view ─────────────────────────────────────────────────────────
function SeriesDetail({ id, onBack, onChanged, toast }) {
  const [schedule, setSchedule] = useState(null)
  const [exceptions, setExceptions] = useState([])
  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // 'pause' | 'generate' | 'delete'
  const [modal, setModal] = useState(null) // { kind: 'skip'|'reschedule'|'edit', date, start, end }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [sch, exs] = await Promise.all([
        get(`/api/recurring/${id}`),
        get(`/api/recurring/${id}/exceptions`).catch(() => []),
      ])
      setSchedule(sch)
      setExceptions(Array.isArray(exs) ? exs : [])
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
    if (!confirm('Cancel this recurring series? Existing scheduled jobs stay on the calendar; no new ones will be generated.')) return
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
    if (!confirm(`Undo the ${ex.exception_type} on ${ex.exception_date}?`)) return
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
      <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded">{error}</div>
      <Button variant="secondary" onClick={onBack} className="mt-4">Back to list</Button>
    </div>
  )
  if (!schedule) return null

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4">
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
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${schedule.active
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-bg-2 text-ink-3'}`}>
              {schedule.active ? 'Active' : 'Paused'}
            </span>
          </div>
          <p className="text-sm text-ink-2">
            {client
              ? <Link to={`/clients/${client.id}`} className="hover:underline">{client.name}</Link>
              : `Client #${schedule.client_id}`}
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
          <ul className="space-y-1.5">
            {upcoming.map((u) => (
              <li key={u.date}
                className={`flex items-center justify-between gap-3 p-3 rounded-xl border ${
                  u.rescheduled
                    ? 'bg-amber-50/60 border-amber-200'
                    : 'bg-panel border-hairline'}`}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">
                    {fmtDate(u.date)}
                    {u.rescheduled && (
                      <span className="ml-2 text-[10px] font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                        rescheduled
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
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-panel border border-hairline">
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
export default function Recurring() {
  const [params, setParams] = useSearchParams()
  const seriesId = params.get('series')
  const { toast, ToastContainer } = useToast()

  const [schedules, setSchedules] = useState([])
  const [clientsById, setClientsById] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')

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

  const openSeries = (id) => setParams({ series: String(id) })
  const backToList = () => setParams({})

  const filtered = useMemo(() => {
    return schedules.filter(s => {
      if (filterStatus === 'active' && !s.active) return false
      if (filterStatus === 'paused' && s.active) return false
      if (filterClient && String(s.client_id) !== String(filterClient)) return false
      return true
    })
  }, [schedules, filterClient, filterStatus])

  const clientOptions = useMemo(
    () => Object.values(clientsById).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [clientsById],
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
        <ToastContainer />
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
            <Link to="/schedule?tab=recurring">
              <Button variant="primary" size="sm">
                <Plus className="w-4 h-4 mr-1" /> New series
              </Button>
            </Link>
          </>
        }
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-8">
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
              { v: 'all', label: 'All' },
              { v: 'active', label: 'Active' },
              { v: 'paused', label: 'Paused' },
            ].map(o => (
              <button key={o.v}
                onClick={() => setFilterStatus(o.v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  filterStatus === o.v ? 'bg-blue-600 text-white' : 'text-ink-3 hover:text-ink'
                }`}>
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-ink-3 ml-auto">
            {filtered.length} of {schedules.length}
          </span>
        </div>

        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded">{error}</div>}

        {loading ? (
          <div className="text-center text-ink-3 py-12 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title={schedules.length === 0 ? 'No recurring series yet' : 'Nothing matches your filters'}
            description={schedules.length === 0
              ? 'Create one from a client, from a signed quote, or from the Schedule tab.'
              : 'Try clearing the client or status filter.'}
            action={schedules.length === 0
              ? <Link to="/schedule?tab=recurring">
                  <Button variant="primary" size="sm"><Plus className="w-4 h-4 mr-1" />New series</Button>
                </Link>
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
              />
            ))}
          </ul>
        )}
      </div>

      <ToastContainer />
    </>
  )
}
