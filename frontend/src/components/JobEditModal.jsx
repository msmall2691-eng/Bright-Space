import { useState, useEffect } from 'react'
import { X, Search, Check, User, Zap } from 'lucide-react'
import { patch } from '../api'
import Button from './ui/Button'

export default function JobEditModal({ job, properties = [], clients = [], onClose, onSave }) {
  const [formData, setFormData] = useState({
    property_id: job?.property_id || '',
    cleaner_ids: job?.cleaner_ids || [],
    notes: job?.notes || '',
  })
  const [cleanerSearch, setCleanerSearch] = useState('')
  const [showCleanerDropdown, setShowCleanerDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Mock cleaner list (in production, fetch from API)
  const mockCleaners = [
    { id: 'cleaner_1', name: 'Alice Johnson' },
    { id: 'cleaner_2', name: 'Bob Smith' },
    { id: 'cleaner_3', name: 'Carol Martinez' },
    { id: 'cleaner_4', name: 'David Lee' },
  ]

  const selectedProperty = properties.find(p => p.id === parseInt(formData.property_id))
  const assignedCleaners = mockCleaners.filter(c => formData.cleaner_ids.includes(c.id))
  const filteredCleaners = mockCleaners.filter(c =>
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

    setSaving(true)
    setError('')
    try {
      await patch(`/api/jobs/${job.id}`, {
        property_id: parseInt(formData.property_id),
        cleaner_ids: formData.cleaner_ids,
        notes: formData.notes,
      })
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
      <div className="w-full sm:w-full max-w-2xl bg-white rounded-none sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-blue-600 p-6 text-white">
          <h2 className="text-2xl font-bold">Edit Job</h2>
          <button onClick={onClose} className="p-1 hover:bg-blue-400 rounded transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-6 space-y-6">
          {/* Job Info */}
          <div>
            <h3 className="text-sm font-semibold text-neutral-600 uppercase mb-2">Job</h3>
            <p className="text-lg font-semibold text-neutral-900">{job?.title}</p>
            <p className="text-sm text-neutral-500">{job?.scheduled_date} • {job?.start_time?.slice(0, 5)} - {job?.end_time?.slice(0, 5)}</p>
          </div>

          {/* Property Picker */}
          <div>
            <label className="block text-sm font-semibold text-neutral-700 mb-3">
              Property <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.property_id}
              onChange={handlePropertyChange}
              className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                  <div key={cleaner.id} className="flex items-center gap-2 bg-green-100 text-green-700 px-3 py-2 rounded-full text-sm">
                    <Check className="w-4 h-4" />
                    {cleaner.name}
                    <button
                      onClick={() => handleRemoveCleaner(cleaner.id)}
                      className="ml-1 hover:bg-green-200 rounded-full p-0.5"
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
                    placeholder="Search cleaners..."
                    value={cleanerSearch}
                    onChange={(e) => setCleanerSearch(e.target.value)}
                    onFocus={() => setShowCleanerDropdown(true)}
                    className="w-full pl-10 pr-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Dropdown */}
              {showCleanerDropdown && filteredCleaners.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-neutral-300 rounded-lg shadow-lg z-10">
                  {filteredCleaners.map(cleaner => (
                    <button
                      key={cleaner.id}
                      onClick={() => handleAddCleaner(cleaner.id)}
                      className="w-full text-left px-4 py-2 hover:bg-blue-50 text-neutral-900 text-sm transition-colors first:rounded-t-lg last:rounded-b-lg"
                    >
                      {cleaner.name}
                    </button>
                  ))}
                </div>
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
              className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>

          {/* Dispatch Status Indicator */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${job?.dispatched ? 'bg-green-500' : 'bg-neutral-400'}`} />
              <div>
                <p className="text-sm font-semibold text-neutral-900">
                  {job?.dispatched ? '✅ Dispatched' : '⏳ Not Dispatched'}
                </p>
                <p className="text-xs text-neutral-600">
                  {job?.dispatched ? 'This job has been sent to cleaners' : 'Job is ready to dispatch'}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-200 bg-neutral-50 p-6 flex gap-3 justify-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
