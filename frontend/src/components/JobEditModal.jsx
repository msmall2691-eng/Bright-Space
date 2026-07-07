import { useState, useEffect, useMemo } from 'react'
import { X, Search, Check, User, Zap, Trash2, Ban, ChevronDown } from 'lucide-react'
import { get, patch, post, del } from '../api'
import Button from './ui/Button'
import { useEmployees } from '../hooks/useEmployees'

/** Resolve a Connecteam employee to an id+name pair, defensively.
 *  Connecteam returns shapes like { userId, firstName, lastName, displayName }
 *  or sometimes { id, name } — handle both. Mirrors CalendarView's logic. */
function normalizeEmployee(e) {
  const id = String(e?.id ?? e?.userId ?? '')
  const composed = [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim()
  const name = e?.name || e?.displayName || composed || `Cleaner ${id}`
  return { id, name }
}

export default function JobEditModal({ job, properties = [], clients = [], onClose, onSave, notify }) {
  const isNew = !job?.id
  const [formData, setFormData] = useState({
    title: job?.title || '',
    job_type: job?.job_type || 'residential',
    status: job?.status || 'scheduled',
    property_id: job?.property_id || '',
    address: job?.address || '',
    cleaner_ids: job?.cleaner_ids || [],
    notes: job?.notes || '',
    scheduled_date: job?.scheduled_date || '',
    start_time: (job?.start_time || '').slice(0, 5),
    end_time: (job?.end_time || '').slice(0, 5),
  })
  const [cleanerSearch, setCleanerSearch] = useState('')
  const [showCleanerDropdown, setShowCleanerDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Everyday edit = date/time/property/cleaner. Type, status, address override,
  // and notes hide behind this toggle. Auto-open when a job already has notes so
  // nothing the operator wrote is hidden on edit.
  const [showAdvanced, setShowAdvanced] = useState(Boolean(job?.notes))

  // Cleaner roster comes from the shared useEmployees hook so this modal
  // reuses the same cached /api/dispatch/employees response CalendarView +
  // useScheduleData already have on the wire (audit §18). normalizeEmployee
  // still handles the shape drift between Connecteam payload variants.
  const { employees, loading: loadingCleaners } = useEmployees()
  const cleaners = useMemo(
    () => (employees || []).map(normalizeEmployee).filter(c => c.id),
    [employees]
  )

  // Per-cleaner availability for the current date + time window. Refetched
  // whenever the operator changes the date or time so the picker's status
  // hints stay in sync. Debounced (250ms) so quick edits don't hammer the
  // endpoint. Audit finding: assigning cleaners blind led to double-bookings.
  const [availability, setAvailability] = useState({}) // { [cleanerId]: {status, detail, conflict_job_id} }
  useEffect(() => {
    if (!formData.scheduled_date) { setAvailability({}); return }
    const t = setTimeout(() => {
      const params = new URLSearchParams({ date: formData.scheduled_date })
      if (formData.start_time) params.append('start', formData.start_time)
      if (formData.end_time) params.append('end', formData.end_time)
      if (job?.id) params.append('exclude_job_id', String(job.id))
      get(`/api/jobs/cleaner-availability?${params.toString()}`)
        .then(rows => {
          const map = {}
          for (const r of (Array.isArray(rows) ? rows : [])) map[String(r.cleaner_id)] = r
          setAvailability(map)
        })
        .catch(() => setAvailability({}))
    }, 250)
    return () => clearTimeout(t)
  }, [formData.scheduled_date, formData.start_time, formData.end_time, job?.id])

  // Editing keeps ownership consistent: only the job's client's properties
  // are offered (the backend rejects cross-client moves anyway). New jobs see
  // everything — the job adopts the chosen property's client.
  const selectableProperties = (!isNew && job?.client_id)
    ? properties.filter(p => !p.client_id || p.client_id === job.client_id)
    : properties
  const selectedProperty = properties.find(p => p.id === parseInt(formData.property_id))
  const assignedCleaners = cleaners.filter(c => formData.cleaner_ids.includes(c.id))
  const filteredCleaners = cleaners.filter(c =>
    !formData.cleaner_ids.includes(c.id) &&
    c.name.toLowerCase().includes(cleanerSearch.toLowerCase())
  )

  const handlePropertyChange = (e) => {
    const prop = properties.find(p => p.id === parseInt(e.target.value))
    setFormData(prev => ({
      ...prev,
      property_id: e.target.value,
      // Smart default only — never clobber an address the operator typed.
      address: prev.address || prop?.address || '',
    }))
  }

  const handleAddCleaner = (cleanerId) => {
    setFormData(prev => ({
      ...prev,
      cleaner_ids: [...prev.cleaner_ids, cleanerId]
    }))
    setCleanerSearch('')
    setShowCleanerDropdown(false)
  }

  const handleRemoveCleaner = (cleanerId) => {
    setFormData(prev => ({
      ...prev,
      cleaner_ids: prev.cleaner_ids.filter(id => id !== cleanerId)
    }))
  }

  // A 409 means a real scheduling conflict (double-booked cleaner, time off,
  // over capacity). The backend supports allow_conflicts to override — offer
  // that explicitly instead of dead-ending the save.
  const [conflict, setConflict] = useState(null)
  const [removing, setRemoving] = useState(false)

  // onSave is invoked with a small envelope describing what changed so the
  // parent can update local state instead of refetching the whole week.
  // Audit §17. `mutated` is the server's response (job row) or null for
  // deletes; `action` lets the parent branch on remove-vs-upsert.
  const notifyParent = (action, mutated) => {
    try { onSave?.({ action, jobId: job?.id, job: mutated || null }) }
    catch { /* onSave was the old zero-arg shape — parent falls back to refetch */ }
  }

  // Hard delete: removes the job AND its Google Calendar event (the backend's
  // DELETE /api/jobs/{id} calls delete_event). Irreversible, so confirm first.
  const handleDelete = async () => {
    if (!job?.id) return
    if (!window.confirm('Delete this job? This permanently removes it and its Google Calendar event.')) return
    setRemoving(true)
    setError('')
    try {
      await del(`/api/jobs/${job.id}`)
      notify?.('Job deleted · calendar event removed')
      notifyParent('delete', null)
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to delete job')
      setRemoving(false)
    }
  }

  // Softer option: keep the record but mark it cancelled (the calendar event is
  // updated/removed by the backend on the status change).
  const handleCancelJob = async () => {
    if (!job?.id) return
    if (!window.confirm('Cancel this job? It will be marked cancelled.')) return
    setRemoving(true)
    setError('')
    try {
      const updated = await patch(`/api/jobs/${job.id}`, { status: 'cancelled' })
      notify?.('Job cancelled')
      notifyParent('update', updated || { ...job, status: 'cancelled' })
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to cancel job')
      setRemoving(false)
    }
  }

  const handleSave = async (allowConflicts = false) => {
    if (!formData.property_id) {
      setError('Please select a property')
      return
    }
    if (isNew && !formData.scheduled_date) {
      setError('Please pick a date')
      return
    }

    setSaving(true)
    setError('')
    setConflict(null)
    try {
      const prop = properties.find(p => p.id === parseInt(formData.property_id))
      const payload = {
        title: formData.title || (prop ? `Cleaning \u2014 ${prop.name}` : 'Cleaning'),
        job_type: formData.job_type || 'residential',
        status: formData.status || 'scheduled',
        property_id: parseInt(formData.property_id),
        address: formData.address || prop?.address || '',
        cleaner_ids: formData.cleaner_ids,
        notes: formData.notes,
        scheduled_date: formData.scheduled_date || null,
        start_time: formData.start_time || null,
        end_time: formData.end_time || null,
        allow_conflicts: allowConflicts,
      }
      let updated
      if (isNew) {
        if (prop?.client_id) payload.client_id = prop.client_id
        updated = await post('/api/jobs', payload)
      } else {
        updated = await patch(`/api/jobs/${job.id}`, payload)
      }
      notifyParent(isNew ? 'create' : 'update', updated)
      onClose()
    } catch (err) {
      const msg = err.message || 'Failed to save job'
      // Backend 409s carry the human-readable conflict detail.
      if (/conflict|unavailable|over capacity|time off|already booked/i.test(msg)) {
        setConflict(msg)
      } else {
        setError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* Right-side drawer (Twenty-style): full-height, slides over the record */}
      <div className="relative h-full w-full sm:max-w-lg bg-panel shadow-2xl flex flex-col overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-blue-600 p-4 sm:p-6 text-white">
          <h2 className="text-xl sm:text-2xl font-bold">{isNew ? "New Job" : "Edit Job"}</h2>
          <button onClick={onClose} className="p-2 sm:p-1 hover:bg-blue-400 rounded transition-colors -mr-2 sm:mr-0">
            <X className="w-5 sm:w-6 h-5 sm:h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-6">
          {/* Status pills — primary control on existing jobs, was buried
              under "Advanced options" per the audit. New jobs default to
              Scheduled with no picker so the create flow stays compact.
              "Unscheduled" is the auto-set status for date-less converted
              quotes (added upstream); flips to Scheduled server-side when
              a date is saved. */}
          {!isNew && (
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Status</label>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { v: 'unscheduled', label: 'Unscheduled', activeCls: 'bg-amber-500 text-white border-amber-500' },
                  { v: 'scheduled',   label: 'Scheduled',   activeCls: 'bg-blue-600 text-white border-blue-600' },
                  { v: 'in_progress', label: 'In progress', activeCls: 'bg-amber-600 text-white border-amber-600' },
                  { v: 'completed',   label: 'Completed',   activeCls: 'bg-emerald-600 text-white border-emerald-600' },
                  { v: 'cancelled',   label: 'Cancelled',   activeCls: 'bg-ink-3 text-white border-ink-3' },
                ].map(({ v, label, activeCls }) => {
                  const active = formData.status === v
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setFormData(f => ({ ...f, status: v }))}
                      className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors ${
                        active ? activeCls : 'bg-bg-2 text-ink-2 border-hairline hover:bg-hairline'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Title — editable on EVERY job, not just new ones */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-2">Job Title</label>
            <input
              type="text"
              value={formData.title}
              onChange={e => setFormData(f => ({ ...f, title: e.target.value }))}
              placeholder="Job title (auto-fills from property if blank)"
              className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base font-medium"
            />
          </div>

          {/* Date + times — finally editable */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-sm font-semibold text-ink-2 mb-2">Date</label>
              <input
                type="date"
                value={formData.scheduled_date || ''}
                onChange={e => setFormData(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Start</label>
              <input
                type="time"
                value={formData.start_time || ''}
                onChange={e => setFormData(f => ({ ...f, start_time: e.target.value }))}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">End</label>
              <input
                type="time"
                value={formData.end_time || ''}
                onChange={e => setFormData(f => ({ ...f, end_time: e.target.value }))}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
          </div>

          {/* Property Picker */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-3">
              Property <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.property_id}
              onChange={handlePropertyChange}
              className="w-full px-4 py-3 sm:py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
            >
              <option value="">Select a property...</option>
              {selectableProperties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} • {p.address}
                </option>
              ))}
            </select>
            {selectedProperty && (
              <p className="text-xs text-ink-3 mt-2">
                Type: <span className="font-semibold capitalize">{selectedProperty.property_type}</span>
              </p>
            )}
          </div>

          {/* Cleaner Selector */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-3">
              <User className="w-4 h-4 inline mr-1" />
              Assign Cleaners
            </label>

            {/* Assigned Cleaners Chips */}
            {assignedCleaners.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {assignedCleaners.map(cleaner => (
                  <div key={cleaner.id} className="flex items-center gap-2 bg-green-100 text-green-700 px-3 py-2 sm:py-2 rounded-full text-xs sm:text-sm">
                    <Check className="w-3 h-3 sm:w-4 sm:h-4" />
                    <span className="truncate">{cleaner.name}</span>
                    <button
                      onClick={() => handleRemoveCleaner(cleaner.id)}
                      className="ml-1 hover:bg-green-200 rounded-full p-0.5 -mr-1"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Search & Add Cleaners */}
            <div className="relative">
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder={loadingCleaners ? 'Loading cleaners…' : (cleaners.length === 0 ? 'No cleaners available' : 'Search cleaners…')}
                    value={cleanerSearch}
                    onChange={(e) => setCleanerSearch(e.target.value)}
                    onFocus={() => setShowCleanerDropdown(true)}
                    disabled={loadingCleaners || cleaners.length === 0}
                    className="w-full pl-10 pr-4 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base disabled:bg-bg disabled:text-ink-3"
                  />
                </div>
              </div>

              {/* Dropdown — each row carries an availability hint sourced
                  from /api/jobs/cleaner-availability so the operator isn't
                  picking blind. Conflicts render red + secondary text; same-
                  day (no time overlap) renders amber; time-off greyed. */}
              {showCleanerDropdown && filteredCleaners.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-panel border border-hairline rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {filteredCleaners.map(cleaner => {
                    const a = availability[String(cleaner.id)]
                    const status = a?.status
                    const rowCls = status === 'conflict' || status === 'off'
                      ? 'bg-red-50/40 hover:bg-red-50'
                      : status === 'same_day'
                        ? 'bg-amber-50/40 hover:bg-amber-50'
                        : 'hover:bg-blue-50'
                    const hintCls = status === 'conflict' || status === 'off'
                      ? 'text-red-600' : status === 'same_day'
                        ? 'text-amber-700' : 'text-emerald-600'
                    const hintLabel = status === 'conflict' ? a.detail
                      : status === 'off' ? a.detail
                      : status === 'same_day' ? a.detail
                      : formData.scheduled_date ? 'Free' : ''
                    return (
                      <button
                        key={cleaner.id}
                        onClick={() => handleAddCleaner(cleaner.id)}
                        className={`w-full text-left px-4 py-3 text-ink text-sm transition-colors first:rounded-t-lg last:rounded-b-lg active:bg-blue-100 flex items-center justify-between gap-2 ${rowCls}`}
                      >
                        <span className="truncate">{cleaner.name}</span>
                        {hintLabel && (
                          <span className={`text-[11px] font-medium shrink-0 ${hintCls}`}>{hintLabel}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {!loadingCleaners && cleaners.length === 0 && (
                <p className="text-xs text-ink-3 mt-2">
                  No cleaners returned from Connecteam. Check the Connecteam integration in Settings.
                </p>
              )}
            </div>

            {assignedCleaners.length === 0 && (
              <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                <Zap className="w-3 h-3" />
                No cleaners assigned
              </p>
            )}
          </div>

          {/* Advanced options — type, status, address override, notes, dispatch.
              Rarely touched on a routine edit, so collapsed by default. */}
          <div className="border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1.5 text-sm font-semibold text-ink-2 hover:text-ink"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              Advanced options
              {!showAdvanced && formData.notes && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              )}
            </button>
          </div>

          {showAdvanced && (<>
            {/* Job Type — Status moved out to a pill row at the top of the
                modal (audit: status was buried under Advanced). */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Job Type</label>
              <select
                value={formData.job_type}
                onChange={e => setFormData(f => ({ ...f, job_type: e.target.value }))}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base bg-panel"
              >
                {!['residential', 'commercial', 'str_turnover', 'one_time'].includes(formData.job_type) && (
                  <option value={formData.job_type}>{formData.job_type || '(unset)'}</option>
                )}
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                <option value="str_turnover">STR Turnover</option>
                <option value="one_time">One-time</option>
              </select>
            </div>

            {/* Address — editable; pre-fills from the property when blank */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Address</label>
              <input
                type="text"
                value={formData.address}
                onChange={e => setFormData(f => ({ ...f, address: e.target.value }))}
                placeholder="Service address (auto-fills from the property)"
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-3">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Add any notes about this job..."
                rows={3}
                className="w-full px-4 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-base"
              />
            </div>

            {/* Dispatch Status Indicator */}
            {!isNew && <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full flex-shrink-0 ${job?.dispatched ? 'bg-green-500' : 'bg-ink-3'}`} />
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-semibold text-ink">
                    {job?.dispatched ? '✅ Dispatched' : '⏳ Not Dispatched'}
                  </p>
                  <p className="text-xs text-ink-2">
                    {job?.dispatched ? 'This job has been sent to cleaners' : 'Job is ready to dispatch'}
                  </p>
                </div>
              </div>
            </div>}
          </>)}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          {conflict && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm">
              <p className="font-semibold text-amber-800 mb-1">Scheduling conflict</p>
              <p className="text-amber-900 mb-3">{conflict}</p>
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="w-full sm:w-auto px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                {saving ? 'Saving…' : 'Save anyway (override conflict)'}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-hairline bg-bg p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 sm:items-center sm:justify-between sticky bottom-0">
          {/* Destructive actions live on the left, away from Save (existing jobs only). */}
          {!isNew ? (
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={removing || saving}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              {formData.status !== 'cancelled' && (
                <button
                  onClick={handleCancelJob}
                  disabled={removing || saving}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-60 transition-colors"
                >
                  <Ban className="w-4 h-4" /> Cancel job
                </button>
              )}
            </div>
          ) : <span className="hidden sm:block" />}
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <Button variant="secondary" onClick={onClose} className="w-full sm:w-auto">
              Close
            </Button>
            <Button variant="primary" onClick={() => handleSave(false)} disabled={saving || removing} className="w-full sm:w-auto">
              {saving ? 'Saving...' : (isNew ? 'Create Job' : 'Save Changes')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
