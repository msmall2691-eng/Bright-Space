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
                          ? 'bg-blue-600 text-white border-blue-600'
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
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
            {busy ? 'Converting…' : 'Convert & schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
