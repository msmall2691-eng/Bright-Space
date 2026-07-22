import { useEffect, useState } from 'react'
import { X, Calendar, Users } from 'lucide-react'
import { get, post } from '../../api'

/** Convert-to-Job confirmation modal.
 *
 * Before this, clicking "Convert to job" on an accepted quote created a
 * `Job` with no date, no crew, no start/end — but with status="scheduled"
 * — which then didn't appear on the calendar and could go stale unnoticed.
 * This modal collects an optional schedule + crew at conversion time so
 * the operator can go from "quote accepted" to "on the calendar with a
 * crew" in one step, and still supports "convert without scheduling"
 * for the case where they'll pick the date later (the resulting Job
 * badge reads Unscheduled).
 */
const _todayISO = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// The intake's requested_date is normally a plain "YYYY-MM-DD", but ISO
// timestamps have leaked through from the website before
// ("2026-07-07T22:18:23.208Z") — take the leading date part either way,
// and return null for anything unrecognizable.
const _parseRequestedISO = (raw) => {
  const m = String(raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

// "2026-07-15" → "Wed, Jul 15, 2026". Built from parts (not new Date(iso))
// so the date can't shift a day on timezones west of UTC.
const _friendlyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

// The customer's preferred arrival window (LeadIntake.custom_fields
// .arrival_window, forwarded from maineclean.co /book) maps to a default
// crew start/end so the operator doesn't hand-type one that contradicts what
// the customer asked for. "flexible" (and anything unrecognized) keeps the
// existing 09:00–12:00 default, so `times` is null for it.
const ARRIVAL_WINDOW_TIMES = {
  morning: { start: '09:00', end: '12:00' },
  afternoon: { start: '12:00', end: '16:00' },
  evening: { start: '16:00', end: '19:00' },
}
const ARRIVAL_WINDOW_LABELS = {
  morning: 'Morning (8am–12pm)',
  afternoon: 'Afternoon (12–4pm)',
  evening: 'Evening (4–7pm)',
  flexible: 'Flexible',
}

// Mirrors JobEditModal's normalizer so a Connecteam roster (which returns
// { userId, firstName, lastName, displayName }) shows up the same as a
// manual roster ({ id, name }) — the previous version dropped every
// Connecteam row on the floor because it only looked at snake_case fields.
function _normalizeEmployee(e) {
  const id = String(e?.id ?? e?.userId ?? '')
  const composed = [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim()
  const name = e?.name || e?.displayName || composed || `Cleaner ${id}`
  return { id, name }
}

export default function ConvertToJobModal({ quote, onClose, onConverted, onError }) {
  const [date, setDate] = useState(_todayISO())
  // Pre-fill a reasonable window so the operator doesn't have to hand-type
  // one — the backend delegates to scheduling.create_job which needs a
  // start + end to run cleaner conflict / calendar guards.
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('12:00')
  const [cleaners, setCleaners] = useState([])
  const [loadingCleaners, setLoadingCleaners] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])
  const [busy, setBusy] = useState(false)
  // The date the CUSTOMER asked for on the original request (LeadIntake
  // .requested_date), "YYYY-MM-DD" or null. Kept separate from `date` so the
  // hint line survives the operator editing the field.
  const [requestedDate, setRequestedDate] = useState(null)
  // The arrival window the customer picked on the original request, kept for
  // the hint line below (and used to seed start/end above).
  const [arrivalWindow, setArrivalWindow] = useState(null)

  // Default the schedule to the customer's requested date instead of blindly
  // "today" — before this, converting an accepted quote silently scheduled
  // the job for the day the operator clicked, not the day the customer asked
  // for. The quote prop may be a list-serialization row (no `intake`), so
  // fall back to fetching the quote detail, which embeds _intake_summary.
  useEffect(() => {
    let alive = true
    const apply = (intake) => {
      if (!alive || !intake) return
      const iso = _parseRequestedISO(intake.requested_date)
      if (iso) {
        setRequestedDate(iso)
        // Only default to it when it's today-or-future — a past request date
        // would fail the backend's past-date guard. The hint below still shows
        // it so the operator sees the (missed) ask.
        if (iso >= _todayISO()) setDate(iso)
      }
      // Pre-fill the crew window from the customer's arrival preference. The
      // summary exposes it as `arrival_window`; tolerate a raw custom_fields
      // shape too. "flexible"/unknown keeps the 09:00–12:00 default.
      const win = intake.arrival_window || intake.custom_fields?.arrival_window || null
      if (win) {
        setArrivalWindow(win)
        const times = ARRIVAL_WINDOW_TIMES[win]
        if (times) {
          setStartTime(times.start)
          setEndTime(times.end)
        }
      }
    }
    if (quote?.intake !== undefined) {
      // Detail-page shape (GET /api/quotes/:id/details) already embeds the
      // intake summary (or an explicit null when the quote has no intake).
      apply(quote?.intake)
    } else if (quote?.id) {
      // List-row shape (_quote_dict) has no intake key — /details is the
      // only serialization that includes _intake_summary.
      get(`/api/quotes/${quote.id}/details`)
        .then(full => apply(full?.intake))
        .catch(() => {})  // hint-only enrichment — never block the modal
    }
    return () => { alive = false }
  }, [quote?.id])

  useEffect(() => {
    setLoadingCleaners(true)
    get('/api/dispatch/employees')
      .then(rows => {
        const list = Array.isArray(rows) ? rows.map(_normalizeEmployee).filter(c => c.id) : []
        setCleaners(list)
      })
      .catch(() => setCleaners([]))
      .finally(() => setLoadingCleaners(false))
  }, [])

  if (!quote) return null

  const toggleCleaner = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const convert = async ({ withSchedule }) => {
    setBusy(true)
    try {
      const payload = withSchedule
        ? {
            scheduled_date: date || null,
            start_time: startTime || null,
            end_time: endTime || null,
            cleaner_ids: selectedIds,
          }
        : {}
      const job = await post(`/api/quotes/${quote.id}/convert-to-job`, payload)
      onConverted?.(job)
    } catch (e) {
      // Backend returns 400 on end<=start / past date, 409 on cleaner conflicts.
      onError?.(e?.message || 'Could not convert to job')
      setBusy(false)
    }
  }

  // Times are pre-filled; require them so we always go through create_job's
  // guard path (double-booking, capacity, Google Free/Busy, Connecteam
  // dispatch). If the operator wants no schedule they use the "without
  // scheduling" button, which posts an empty payload.
  const timeValid = !!startTime && !!endTime && endTime > startTime
  const dateValid = !!date

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center sm:justify-center">
      <div className="w-full sm:w-[520px] bg-panel sm:rounded-xl shadow-2xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-blue-500" />
            <h2 className="font-semibold text-ink">Convert quote to job</h2>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">
          <p className="text-xs text-ink-3">
            {quote.quote_number} · {quote.title || 'Untitled quote'}
          </p>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-ink-3 mb-1">Scheduled date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              {requestedDate && (
                // Always shown (even for a past date, or after the operator
                // picks another day) so the customer's ask stays visible.
                <p className="text-[11px] text-ink-3 mt-1">
                  Customer requested: {_friendlyDate(requestedDate)}
                  {requestedDate < _todayISO() && ' (in the past)'}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-ink-3 mb-1">Start (optional)</label>
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs text-ink-3 mb-1">End (optional)</label>
                <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            </div>
            {arrivalWindow && (
              // Mirror the "Customer requested:" date hint — surface the
              // arrival window the customer picked so the operator sees why
              // the crew times are pre-filled (and can still override).
              <p className="text-[11px] text-ink-3">
                Customer prefers: {ARRIVAL_WINDOW_LABELS[arrivalWindow] || arrivalWindow}
              </p>
            )}
            {!timeValid && (
              <p className="text-[11px] text-red-500">End time must be after start time.</p>
            )}
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs text-ink-3 mb-2">
              <Users className="w-3.5 h-3.5" /> Assign crew (optional)
            </label>
            {loadingCleaners ? (
              <p className="text-xs text-ink-3 italic">Loading crew…</p>
            ) : cleaners.length === 0 ? (
              <p className="text-xs text-ink-3 italic">
                No crew available — assign after conversion from the job page.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {cleaners.map(c => {
                  const on = selectedIds.includes(c.id)
                  return (
                    <button key={c.id} type="button" onClick={() => toggleCleaner(c.id)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        on
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-bg-2 text-ink-3 border-hairline hover:border-blue-400'
                      }`}>
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-hairline shrink-0 flex flex-col sm:flex-row gap-2">
          <button onClick={onClose}
            className="flex-1 sm:flex-none px-3 py-2 rounded-lg text-sm text-ink-3 hover:bg-bg-2 transition-colors">
            Cancel
          </button>
          <button onClick={() => convert({ withSchedule: false })} disabled={busy}
            className="flex-1 px-3 py-2 rounded-lg text-sm bg-bg-2 text-ink-2 hover:bg-bg-3 border border-hairline disabled:opacity-50 transition-colors">
            Convert without scheduling
          </button>
          <button onClick={() => convert({ withSchedule: true })}
            disabled={busy || !dateValid || !timeValid}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
            {busy ? 'Converting…' : 'Convert & schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
