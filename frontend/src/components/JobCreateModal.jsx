import { useState, useEffect } from 'react'
import { X, Calendar, Clock, MapPin, AlertCircle, Home } from 'lucide-react'
import { get, post } from '../api'

const JOB_TYPES = [
  { value: 'residential',  label: 'Residential' },
  { value: 'commercial',   label: 'Commercial' },
  { value: 'str_turnover', label: 'STR Turnover' },
]

function jobTypeFromProperty(propertyType) {
  const t = (propertyType || '').toLowerCase()
  if (t === 'commercial') return 'commercial'
  if (t === 'str') return 'str_turnover'
  return 'residential'
}

export default function JobCreateModal({
  clientId,
  clientName,
  initialPropertyId = null,
  initialDate = '',
  onClose,
  onCreated,
}) {
  const [properties, setProperties] = useState([])
  const [loadingProps, setLoadingProps] = useState(false)
  const [form, setForm] = useState({
    title: clientName ? `${clientName} — Clean` : '',
    job_type: 'residential',
    scheduled_date: initialDate,
    start_time: '09:00',
    end_time: '12:00',
    address: '',
    notes: '',
    property_id: initialPropertyId ? String(initialPropertyId) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!clientId) return
    setLoadingProps(true)
    get(`/api/properties?client_id=${clientId}`)
      .then(data => {
        const list = Array.isArray(data) ? data : []
        setProperties(list)
        // If we have an initialPropertyId, pre-fill address/job_type from it
        if (initialPropertyId) {
          const prop = list.find(p => p.id === parseInt(initialPropertyId))
          if (prop) applyProperty(prop)
        }
      })
      .catch(e => {
        console.error('[JobCreateModal] failed to load properties', e)
        setProperties([])
      })
      .finally(() => setLoadingProps(false))
  }, [clientId])

  const applyProperty = (prop) => {
    setForm(f => ({
      ...f,
      property_id: String(prop.id),
      address: [prop.address, prop.city, prop.state].filter(Boolean).join(', '),
      job_type: jobTypeFromProperty(prop.property_type),
    }))
  }

  const onPropertyChange = (e) => {
    const propId = e.target.value
    if (!propId) {
      setForm(f => ({ ...f, property_id: '' }))
      return
    }
    const prop = properties.find(p => String(p.id) === propId)
    if (prop) applyProperty(prop)
  }

  const canSave = form.title && form.scheduled_date && form.start_time && form.end_time

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const body = {
        client_id: parseInt(clientId),
        title: form.title,
        job_type: form.job_type,
        scheduled_date: form.scheduled_date,
        start_time: form.start_time,
        end_time: form.end_time,
        address: form.address || null,
        notes: form.notes || null,
        property_id: form.property_id ? parseInt(form.property_id) : null,
      }
      const job = await post('/api/jobs', body)
      onCreated?.(job)
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Failed to create job')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center sm:justify-end"
      data-testid="job-create-modal"
    >
      <div className="w-full sm:w-[420px] bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh] sm:max-h-[95vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
          <h2 className="font-semibold text-zinc-900">Schedule Job</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
          {clientName && (
            <div className="text-xs text-zinc-500">
              For client <span className="font-medium text-zinc-700">{clientName}</span>
            </div>
          )}

          {/* Property picker (filtered by client) */}
          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">Property</label>
            <select
              value={form.property_id}
              onChange={onPropertyChange}
              data-testid="job-create-property-select"
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              disabled={loadingProps}
            >
              <option value="">
                {loadingProps
                  ? 'Loading properties...'
                  : properties.length === 0
                    ? 'No properties for this client'
                    : 'Select a property (optional)'}
              </option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.address ? ` — ${p.address}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">Title *</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Smith Residence — Deep Clean"
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">Service Type</label>
            <div className="flex gap-2">
              {JOB_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, job_type: t.value }))}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    form.job_type === t.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">
              <Calendar className="w-3 h-3 inline mr-1" /> Date *
            </label>
            <input
              type="date"
              value={form.scheduled_date}
              onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-zinc-700 font-medium mb-1">
                <Clock className="w-3 h-3 inline mr-1" /> Start *
              </label>
              <input
                type="time"
                value={form.start_time}
                onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-zinc-700 font-medium mb-1">End *</label>
              <input
                type="time"
                value={form.end_time}
                onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">
              <MapPin className="w-3 h-3 inline mr-1" /> Address
            </label>
            <input
              value={form.address}
              onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
              placeholder="123 Main St, Portland, ME"
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-700 font-medium mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="Special instructions, access codes, etc."
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="p-6 border-t border-zinc-200">
          <button
            onClick={save}
            disabled={saving || !canSave}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? 'Creating...' : 'Create Job'}
          </button>
        </div>
      </div>
    </div>
  )
}
