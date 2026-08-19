import { useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { get, post, patch, del } from '../../api'
import Button from '../ui/Button'
import GlassCard from '../ui/GlassCard'
import { toast } from '../../utils/toastBus'
import { confirmDialog } from '../../utils/confirmBus'

/** AvailabilityPanel: cleaner time-off entries (CRUD against /api/jobs/time-off).
 *  Mounts as a top-level view (no props) when ?tab=availability routes the
 *  Schedule page here, so it owns its own data loading.
 *
 *  Recurring-series creation used to live here too (RecurringCreateModal +
 *  RecurringPanel), but both were dead code — Schedule.jsx's ?tab=recurring
 *  redirects to the dedicated /recurring page, which creates series via the
 *  shared JobCreateModal (components/JobCreateModal.jsx) instead. */

export function AvailabilityPanel() {
  const [entries, setEntries] = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ cleaner_id: '', start_date: '', end_date: '', reason: 'vacation' })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [rows, emps] = await Promise.all([
        get('/api/jobs/time-off'),
        get('/api/dispatch/employees').catch(() => []),
      ])
      setEntries(Array.isArray(rows) ? rows : [])
      setEmployees(Array.isArray(emps) ? emps : [])
    } catch (e) {
      toast.error(e.message || 'Failed to load time off')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const empName = (id) => employees.find(e => String(e.id) === String(id))?.name || `Cleaner ${id}`

  const add = async () => {
    if (!form.cleaner_id || !form.start_date || !form.end_date) {
      toast.error('Pick a cleaner and both dates')
      return
    }
    setSaving(true)
    try {
      await post('/api/jobs/time-off', {
        cleaner_id: String(form.cleaner_id),
        cleaner_name: empName(form.cleaner_id),
        start_date: form.start_date,
        end_date: form.end_date,
        reason: form.reason || null,
      })
      toast.success('Time off added')
      setForm({ cleaner_id: '', start_date: '', end_date: '', reason: 'vacation' })
      await load()
    } catch (e) {
      toast.error(e.message || 'Could not add time off')
    }
    setSaving(false)
  }

  const remove = async (id) => {
    if (!(await confirmDialog('Remove this time-off entry?'))) return
    try {
      await del(`/api/jobs/time-off/${id}`)
      setEntries(entries.filter(e => e.id !== id))
    } catch (e) {
      toast.error(e.message || 'Could not remove')
    }
  }

  const setStatus = async (id, status) => {
    try {
      const updated = await patch(`/api/jobs/time-off/${id}/status`, { status })
      setEntries(entries.map(e => (e.id === id ? updated : e)))
      toast.success(status === 'approved' ? 'Approved — they got a ping' : 'Denied — they got a ping')
    } catch (e) {
      toast.error(e.message || 'Could not update')
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-bold text-ink mb-1">Cleaner availability</h1>
      <p className="text-sm text-ink-3 mb-5">
        Mark a cleaner off for a date range. They can't be assigned to jobs on those days
        (override per-job if needed).
      </p>

      <GlassCard className="p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">Cleaner</label>
            <select value={form.cleaner_id} onChange={e => setForm(f => ({ ...f, cleaner_id: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
              <option value="">Select…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">Reason</label>
            <select value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
              <option value="vacation">Vacation</option>
              <option value="sick">Sick</option>
              <option value="personal">Personal</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">From</label>
            <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">To</label>
            <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={add} disabled={saving}>
            {saving ? 'Adding…' : 'Add time off'}
          </Button>
        </div>
      </GlassCard>

      {loading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-3 italic">No upcoming time off scheduled.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map(e => (
            <li key={e.id} className="flex items-center justify-between bg-panel border border-hairline rounded-lg px-3 py-2.5">
              <div>
                <span className="text-sm font-semibold text-ink">{e.cleaner_name || empName(e.cleaner_id)}</span>
                <span className="text-xs text-ink-3 ml-2">{e.start_date} → {e.end_date}</span>
                {e.reason && <span className="text-[11px] text-ink-3 ml-2 capitalize">· {e.reason}</span>}
                {e.status === 'requested' && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300 ml-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" /> Requested
                  </span>
                )}
                {e.status === 'denied' && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-3 ml-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-ink-3/40 shrink-0" aria-hidden="true" /> Denied
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {e.status === 'requested' && (
                  /* Crew-submitted ask (migration 089): decide it here. The
                     requester's phone gets a push either way. */
                  <>
                    <button onClick={() => setStatus(e.id, 'approved')}
                      className="text-[11px] font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2 py-1 hover:bg-bg-2">
                      Approve
                    </button>
                    <button onClick={() => setStatus(e.id, 'denied')}
                      className="text-[11px] font-semibold text-ink-2 bg-bg-2 border border-hairline rounded-lg px-2 py-1 hover:bg-bg-3">
                      Deny
                    </button>
                  </>
                )}
                <button onClick={() => remove(e.id)} className="text-ink-3 hover:text-red-500 p-1" aria-label="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
