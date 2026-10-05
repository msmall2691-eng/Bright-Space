/**
 * Recurring — pure helpers shared by the page and its screens.
 *
 * Extracted verbatim from `pages/Recurring.jsx`, which held four screens,
 * three modals and all of this in one 1795-line file. Nothing here touches
 * React or the network: date maths, label formatting, and the client-side
 * occurrence projection.
 */

/** Resolve a roster employee to an id+name pair, defensively. Mirrors
 *  JobEditModal's normalizeEmployee — legacy roster rows carry shapes like
 *  { userId, firstName, lastName, displayName }; native rows are { id, name }. */
export function normalizeEmployee(e) {
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

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Backend and shared frontend convention: Python weekday numbering
// (Mon=0..Sun=6). JS Date.getDay() returns Sun=0..Sat=6, so we translate.
export const pyWeekday = (d) => (d.getDay() + 6) % 7
export const isoDate = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
export const parseISO = (s) => {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
// Monday that starts d's week — the unit biweekly cadence is counted in.
export const mondayOf = (d) => { const m = new Date(d); m.setDate(m.getDate() - pyWeekday(d)); m.setHours(0, 0, 0, 0); return m }
export const daysBetween = (a, b) => Math.round((a - b) / 86400000)

export function ruleSummary(s) {
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

export function endsSummary(s) {
  if (!s) return ''
  if (s.ends_mode === 'after_count' && s.series_end_occurrences) {
    return `Ends after ${s.series_end_occurrences} visit${s.series_end_occurrences === 1 ? '' : 's'}`
  }
  if (s.ends_mode === 'on_date' && s.ends_on) return `Ends ${fmtDate(s.ends_on)}`
  return 'Never ends'
}

export function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hh = parseInt(h, 10)
  const ampm = hh >= 12 ? 'pm' : 'am'
  const h12 = hh % 12 || 12
  return `${h12}:${m}${ampm}`
}
export function fmtDate(d) {
  if (!d) return ''
  const dt = typeof d === 'string' ? parseISO(d) : d
  if (!dt) return ''
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// Mirror of backend `generate_dates` — computes projected upcoming dates from
// the rule and applies exceptions (skips remove, reschedules substitute).
// Match the backend algorithm exactly so what we show equals what will be
// materialized on the next generate. `generate_weeks_ahead` bounds the window.
export function computeUpcoming(schedule, exceptions, maxCount = 8) {
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

/** Health-scan severity → the leading dot. */
export const SEVERITY_DOT = { error: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-gray-400' }
