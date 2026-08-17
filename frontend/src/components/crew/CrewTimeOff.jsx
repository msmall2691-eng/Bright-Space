/**
 * Me tab — request time off (crew app self-service).
 *
 * A request is an ASK: it shows the office immediately (push + their
 * time-off panel) but doesn't block scheduling until approved. Pending
 * requests can be withdrawn; approved ones belong to the office's calendar.
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarOff, X } from 'lucide-react'
import { get, post, del } from '../../api'
import StatusBadge from '../ui/StatusBadge'

const STATUS = { requested: 'warning', approved: 'success', denied: 'neutral' }
const LABEL = { requested: 'Pending', approved: 'Approved', denied: 'Not approved' }

export default function CrewTimeOff() {
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState({ start_date: '', end_date: '', reason: '' })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    get('/api/crew/me/time-off').then(setRows).catch(() => setRows([]))
  }, [])
  useEffect(() => { load() }, [load])

  const submit = async () => {
    if (!form.start_date) { setError('Pick a start date'); return }
    setBusy(true); setError(null)
    try {
      await post('/api/crew/me/time-off', {
        start_date: form.start_date,
        end_date: form.end_date || form.start_date,
        reason: form.reason.trim() || undefined,
      })
      setForm({ start_date: '', end_date: '', reason: '' })
      setOpen(false)
      load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not send the request')
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (id) => {
    setBusy(true)
    try { await del(`/api/crew/me/time-off/${id}`); load() }
    catch (e) { setError(e.detail || e.message || 'Could not withdraw') }
    finally { setBusy(false) }
  }

  const fmt = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-ink flex items-center gap-1.5">
            <CalendarOff className="w-4 h-4 text-ink-3" /> Time off
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Ask ahead — the office approves. Same-day emergencies are still a call.
          </p>
        </div>
        {!open && (
          <button onClick={() => { setError(null); setOpen(true) }}
            className="shrink-0 text-[12px] font-semibold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
            Request
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 border border-hairline rounded-xl p-3 bg-bg">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-ink-3">First day off</span>
              <input type="date" value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border border-hairline bg-panel px-2 py-1.5 text-[13px] text-ink focus:outline-none" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">Last day (optional)</span>
              <input type="date" value={form.end_date} min={form.start_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border border-hairline bg-panel px-2 py-1.5 text-[13px] text-ink focus:outline-none" />
            </label>
          </div>
          <input value={form.reason} maxLength={200}
            onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
            placeholder="Reason (optional) — e.g. family trip"
            className="w-full rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-[13px] text-ink focus:outline-none" />
          <div className="flex gap-2">
            <button onClick={() => setOpen(false)} disabled={busy}
              className="flex-1 text-[12.5px] font-semibold bg-panel border border-hairline text-ink-2 py-2 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors">
              Cancel
            </button>
            <button onClick={submit} disabled={busy}
              className="flex-1 text-[12.5px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg disabled:opacity-60 transition-colors">
              {busy ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {rows && rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-ink-2 min-w-0 truncate">
                {fmt(r.start_date)}{r.end_date !== r.start_date ? ` – ${fmt(r.end_date)}` : ''}
                {r.reason ? <span className="text-ink-3"> · {r.reason}</span> : ''}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <StatusBadge status={STATUS[r.status] || 'neutral'} className={r.status === 'denied' ? 'line-through' : ''}>
                  {LABEL[r.status] || r.status}
                </StatusBadge>
                {r.status === 'requested' && (
                  <button onClick={() => withdraw(r.id)} disabled={busy} title="Withdraw"
                    className="text-ink-3 hover:text-ink-2 p-0.5"><X className="w-3.5 h-3.5" /></button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
