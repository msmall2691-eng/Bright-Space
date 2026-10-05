import { useState } from 'react'
import { post } from '../../api'
import Button from '../ui/Button'
import ErrorNote from '../ui/ErrorNote'
import ModalShell from './ModalShell'
import { fmtDate } from './helpers'

export default function SkipModal({ schedule, date, onClose, onDone }) {
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
