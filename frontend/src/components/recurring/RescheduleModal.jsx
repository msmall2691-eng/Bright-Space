import { useState } from 'react'
import { post } from '../../api'
import Button from '../ui/Button'
import ErrorNote from '../ui/ErrorNote'
import ModalShell from './ModalShell'
import { fmtDate } from './helpers'

export default function RescheduleModal({ schedule, date, defaultStart, defaultEnd, onClose, onDone }) {
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
