import { useState, useEffect } from 'react'
import { X, Search, Check, User, Zap } from 'lucide-react'
import { get, patch, post } from '../api'
import Button from './ui/Button'

/** Resolve a Connecteam employee to an id+name pair, defensively.
 *  Connecteam returns shapes like { userId, firstName, lastName, displayName }
 *  or sometimes { id, name } — handle both. Mirrors CalendarView's logic. */
function normalizeEmployee(e) {
  const id = String(e?.id ?? e?.userId ?? '')
  const composed = [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim()
  const name = e?.name || e?.displayName || composed || `Cleaner ${id}`
  return { id, name }
}

export default function JobEditModal({ job, properties = [], clients = [], onClose, onSave }) {
  const isNew = !job?.id
  const [formData, setFormData] = useState({
    title: job?.title || '',
    property_id: job?.property_id || '',
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

  // Real cleaner roster from Connecteam via /api/dispatch/employees.
  // Mirrors the fetch CalendarView already does. Defensive: tolerates 502s
  // (Connecteam offline) by leaving the list empty.
  const [cleaners, setCleaners] = useState([])
  const [loadingCleaners, setLoadingCleaners] = useState(false)

  useEffect(() => {
    setLoadingCleaners(true)
    get('/api/dispatch/employees')
      .then(rows => {
        const list = Array.isArray(rows) ? rows.map(normalizeEmployee).filter(c => c.id) : []
        setCleaners(list)
      })
      .catch(err => {
        console.error('[JobEditModal] failed to load cleaners', err)
        setCleaners([])
      })
      .finally(() => setLoadingCleaners(false))
  }, [])

  const selectedProperty = properties.find(p => p.id === parseInt(formData.property_id))
  const assignedCleaners = cleaners.filter(c => formData.cleaner_ids.includes(c.id))
  const filteredCleaners = cleaners.filter(c =>
    !formData.cleaner_ids.includes(c.id) &&
    c.name.toLowerCase().includes(cleanerSearch.toLowerCase())
  )

  const handlePropertyChange = (e) => {
    setFormData(prev => ({ ...prev, property_id: e.target.value }))
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

  const handleSave = async () => {
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
    try {
      const prop = properties.find(p => p.id === parseInt(formData.property_id))
      const payload = {
        property_id: parseInt(formData.property_id),
        cleaner_ids: formData.cleaner_ids,
        notes: formData.notes,
        scheduled_date: formData.scheduled_date || null,
        start_time: formData.start_time || null,
        end_time: formData.end_time || null,
      }
      if (isNew) {
        payload.title = formData.title || (prop ? `Cleaning \u2014 ${prop.name}` : 'Cleaning')
        payload.job_type = 'one_time'
        payload.status = 'scheduled'
        if (prop?.client_id) payload.client_id = prop.client_id
        if (prop?.address) payload.address = prop.address
        await post('/api/jobs', payload)
      } else {
        await patch(`/api/jobs/${job.id}`, payload)
      }
      onSave?.()
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to save job')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-center">
      <div className="w-full sm:w-full max-w-2xl bg-white rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-blue-600 p-4 sm:p-6 text-white">
          <h2 className="text-xl sm:text-2xl font-bold">{isNew ? "New Job" : "Edit Job"}</h2>
          <button onClick={onClose} className="p-2 sm:p-1 hover:bg-blue-400 rounded transition-colors -mr-2 sm:mr-0">
            <X className="w-5 sm:w-6 h-5 sm:h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-6">
          {/* Job Info */}
          <div>
            <h3 className="text-xs font-semibold text-neutral-600 uppercase mb-2">Job</h3>
            {isNew ? (
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData(f => ({ ...f, title: e.target.value }))}
                placeholder="Job title (auto-fills from property if blank)"
                className="w-full px-3 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            ) : (
              <p className="text-base sm:text-lg font-semibold text-neutral-900">{job?.title}</p>
            )}
          </div>

          {/* Date + times — finally editable */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className="block text-sm font-semibold text-neutral-700 mb-2">Date</label>
              <input
                type="date"
                value={formData.scheduled_date || ''}
                onChange={e => setFormData(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full px-3 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-neutral-700 mb-2">Start</label>
              <input
                type="time"
                value={formData.start_time || ''}
                onChange={e => setFormData(f => ({ ...f, start_time: e.target.value }))}
                className="w-full px-3 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-neutral-700 mb-2">End</label>
              <input
                type="time"
                value={formData.end_time || ''}
                onChange={e => setFormData(f => ({ ...f, end_time: e.target.value }))}
                className="w-full px-3 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
              />
            </div>
          </div>

          {/* Property Picker */}
          <div>
            <label className="block text-sm font-semibold text-neutral-700 mb-3">
              Property <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.property_id}
              onChange={handlePropertyChange}
              className="w-full px-4 py-3 sm:py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base"
            >
              <option value="">Select a property...</option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} • {p.address}
                </option>
              ))}
            </select>
            {selectedProperty && (
              <p className="text-xs text-neutral-500 mt-2">
                Type: <span className="font-semibold capitalize">{selectedProperty.property_type}</span>
              </p>
            )}
          </div>

          {/* Cleaner Selector */}
          <div>
            <label className="block text-sm font-semibold text-neutral-700 mb-3">
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
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder={loadingCleaners ? 'Loading cleaners…' : (cleaners.length === 0 ? 'No cleaners available' : 'Search cleaners…')}
                    value={cleanerSearch}
                    onChange={(e) => setCleanerSearch(e.target.value)}
                    onFocus={() => setShowCleanerDropdown(true)}
                    disabled={loadingCleaners || cleaners.length === 0}
                    className="w-full pl-10 pr-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-base disabled:bg-neutral-50 disabled:text-neutral-400"
                  />
                </div>
              </div>

              {/* Dropdown */}
              {showCleanerDropdown && filteredCleaners.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-neutral-300 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {filteredCleaners.map(cleaner => (
                    <button
                      key={cleaner.id}
                      onClick={() => handleAddCleaner(cleaner.id)}
                      className="w-full text-left px-4 py-3 hover:bg-blue-50 text-neutral-900 text-sm transition-colors first:rounded-t-lg last:rounded-b-lg active:bg-blue-100"
                    >
                      {cleaner.name}
                    </button>
                  ))}
                </div>
              )}
              {!loadingCleaners && cleaners.length === 0 && (
                <p className="text-xs text-neutral-500 mt-2">
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

          {/* Notes */}
          <div>
            <label className="block text-sm font-semibold text-neutral-700 mb-3">Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Add any notes about this job..."
              rows={3}
              className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-base"
            />
          </div>

          {/* Dispatch Status Indicator */}
          {!isNew && <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 ${job?.dispatched ? 'bg-green-500' : 'bg-neutral-400'}`} />
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-semibold text-neutral-900">
                  {job?.dispatched ? '✅ Dispatched' : '⏳ Not Dispatched'}
                </p>
                <p className="text-xs text-neutral-600">
                  {job?.dispatched ? 'This job has been sent to cleaners' : 'Job is ready to dispatch'}
                </p>
              </div>
            </div>
          </div>}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-200 bg-neutral-50 p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
          <Button variant="secondary" onClick={onClose} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
            {saving ? 'Saving...' : (isNew ? 'Create Job' : 'Save Changes')}
          </Button>
        </div>
      </div>
    </div>
  )
}
