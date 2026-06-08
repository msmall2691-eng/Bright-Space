import { useState, useEffect } from 'react'
import { X, Calendar, Clock, MapPin, AlertCircle, Repeat as RepeatIcon } from 'lucide-react'
import { get, post } from '../api'

const JOB_TYPES = [
  { value: 'residential',  label: 'Residential' },
  { value: 'commercial',   label: 'Commercial' },
  { value: 'str_turnover', label: 'STR Turnover' },
]

const FREQUENCIES = [
  { value: 'daily',          label: 'Daily',          interval: 1 },
  { value: 'weekly',         label: 'Weekly',         interval: 1 },
  { value: 'biweekly',       label: 'Every 2 weeks',  interval: 2 },
  { value: 'every_3_weeks',  label: 'Every 3 weeks',  interval: 3 },
  { value: 'every_4_weeks',  label: 'Every 4 weeks',  interval: 4 },
  { value: 'monthly',        label: 'Monthly',        interval: null },
]

const WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function jobTypeFromProperty(propertyType) {
  const t = (propertyType || '').toLowerCase()
  if (t === 'commercial') return 'commercial'
  if (t === 'str') return 'str_turnover'
  return 'residential'
}

/**
 * Unified Schedule Job modal.
 *
 * Two modes selected by the "Repeat" toggle:
 *  - One-time (default): single Date field. Submit → POST /api/jobs.
 *  - Recurring: Frequency + Days of Week (or Day of Month) + Generate-ahead.
 *               Submit → POST /api/recurring (RecurringSchedule, which then
 *               generates the first batch of Jobs).
 *
 * Replaces the previous parallel JobCreateModal + inline RecurringSchedule
 * modal in ClientProfile. Common fields share a single source of truth.
 */
export default function JobCreateModal({
  clientId,
  clientName,
  initialPropertyId = null,
  initialDate = '',
  initialJobType = null,
  initialTitle = null,
  defaultRecurring = false,
  onClose,
  onCreated,
}) {
  const [properties, setProperties] = useState([])
  const [loadingProps, setLoadingProps] = useState(false)
  const [recurring, setRecurring] = useState(defaultRecurring)
  const [form, setForm] = useState({
    title: initialTitle || (clientName ? `${clientName} — Clean` : ''),
    job_type: initialJobType || 'residential',
    scheduled_date: initialDate,
    start_time: '09:00',
    end_time: '12:00',
    address: '',
    notes: '',
    property_id: initialPropertyId ? String(initialPropertyId) : '',
    // Recurring-only fields
    frequency: 'biweekly',
    interval_weeks: 2,
    days_of_week: [0],
    day_of_month: 1,
    generate_weeks_ahead: 8,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Inline "new property" quick-add (a client may have none yet).
  const [addingProp, setAddingProp] = useState(false)
  const [newProp, setNewProp] = useState({ name: '', address: '' })
  const [creatingProp, setCreatingProp] = useState(false)
  const [propErr, setPropErr] = useState('')

  // Standalone mode (opened from the Schedule page, not a client): pick the
  // client here. When clientId is passed in (from a client profile) it's fixed.
  const standalone = !clientId
  const [activeClientId, setActiveClientId] = useState(clientId ? String(clientId) : '')
  const [clients, setClients] = useState([])
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')

  // In standalone mode, load the client list for the picker. Raise the limit
  // well above the API's default 50 so orgs with many clients can still pick an
  // existing one (rather than being pushed into creating a duplicate).
  useEffect(() => {
    if (!standalone) return
    get('/api/clients?status=active&limit=1000')
      .then(d => setClients(Array.isArray(d) ? d : []))
      .catch(() => setClients([]))
  }, [standalone])

  // Load the active client's properties whenever it changes.
  useEffect(() => {
    if (!activeClientId) { setProperties([]); return }
    setLoadingProps(true)
    get(`/api/properties?client_id=${activeClientId}`)
      .then(data => {
        const list = Array.isArray(data) ? data : []
        setProperties(list)
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
  }, [activeClientId])

  const selectClient = (idStr) => {
    setActiveClientId(idStr)
    // Reset everything tied to the *previous* client's property — otherwise a
    // stale property_id/address/job_type could save a job for the new client
    // pointing at the old client's property (the endpoints don't cross-check).
    setProperties([])
    setAddingProp(false)
    const c = clients.find(c => String(c.id) === String(idStr))
    setForm(f => ({
      ...f,
      property_id: '',
      job_type: 'residential',
      address: c ? [c.address, c.city, c.state].filter(Boolean).join(', ') : '',
      // Keep a user-typed title; otherwise default to the client's name.
      title: (!f.title || /—\s*Clean$/.test(f.title)) && c ? `${c.name} — Clean` : f.title,
    }))
  }

  const createInlineClient = async () => {
    if (!newClient.name.trim()) { setClientErr('Name is required'); return }
    setCreatingClient(true); setClientErr('')
    try {
      const created = await post('/api/clients', {
        name: newClient.name.trim(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        status: 'active',
      })
      setClients(cs => [created, ...cs])
      selectClient(String(created.id))
      setAddingClient(false)
      setNewClient({ name: '', phone: '', email: '' })
    } catch (e) {
      setClientErr(e.message || 'Failed to create client')
    }
    setCreatingClient(false)
  }

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

  // Create a property for this client without leaving the job form, then select it.
  const createInlineProperty = async () => {
    if (!newProp.name.trim()) { setPropErr('Property name is required'); return }
    setCreatingProp(true); setPropErr('')
    try {
      const created = await post('/api/properties', {
        client_id: parseInt(activeClientId),
        name: newProp.name.trim(),
        address: newProp.address.trim() || '',
        property_type: form.job_type === 'str' ? 'str' : form.job_type || 'residential',
      })
      setProperties(ps => [created, ...ps])
      applyProperty(created)
      setAddingProp(false)
      setNewProp({ name: '', address: '' })
    } catch (e) {
      setPropErr(e.message || 'Failed to create property')
    }
    setCreatingProp(false)
  }

  // Validation differs by mode; both require a client (picked here in standalone
  // mode, or supplied by the client profile).
  const canSave = !!activeClientId && (recurring
    ? form.title && form.address &&
      (form.frequency === 'monthly'
        ? !!form.day_of_month
        : form.frequency === 'daily'
          ? true                                   // daily: every day (days optional)
          : (form.days_of_week || []).length > 0)
    : form.title && form.scheduled_date && form.start_time && form.end_time)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (recurring) {
        const body = {
          client_id: parseInt(activeClientId),
          property_id: form.property_id ? parseInt(form.property_id) : null,
          job_type: form.job_type,
          title: form.title,
          address: form.address,
          frequency: form.frequency,
          interval_weeks: form.frequency === 'monthly'
            ? null
            : parseInt(form.interval_weeks || 1),
          days_of_week: (form.days_of_week || [0]).map(Number),
          day_of_week: (form.days_of_week || [0]).map(Number)[0] ?? 0,
          day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
          start_time: form.start_time,
          end_time: form.end_time,
          generate_weeks_ahead: parseInt(form.generate_weeks_ahead),
          notes: form.notes || null,
        }
        const sched = await post('/api/recurring', body)
        onCreated?.({ kind: 'recurring', schedule: sched })
        onClose?.()
        return
      }
      const body = {
        client_id: parseInt(activeClientId),
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
      onCreated?.({ kind: 'job', job, gcal: job?.gcal })
      onClose?.()
    } catch (e) {
      setError(e?.message || `Failed to create ${recurring ? 'schedule' : 'job'}`)
    } finally {
      setSaving(false)
    }
  }

  // 3-step guided flow: Who (client + property) → What (title, type, repeat,
  // notes) → When (date/recurrence + times + address). All the state, handlers
  // and submit logic above are unchanged; the steps are purely a layout over
  // them, so every call site keeps working.
  const [step, setStep] = useState(1)
  const STEPS = [{ n: 1, label: 'Who' }, { n: 2, label: 'What' }, { n: 3, label: 'When' }]
  const step1Valid = !!activeClientId          // a client must be chosen/known
  const step2Valid = !!form.title              // job_type always has a default
  const goNext = () => setStep(s => Math.min(3, s + 1))
  const goBack = () => setStep(s => Math.max(1, s - 1))
  const btn = "px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center sm:justify-end"
      data-testid="job-create-modal"
    >
      <div className="w-full sm:w-[420px] bg-panel rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh] sm:max-h-[95vh]">
        <div className="px-6 py-4 border-b border-hairline">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-ink">
              {recurring ? 'Recurring Schedule' : 'Schedule Job'}
              {clientName && <span className="ml-2 text-xs text-ink-3 font-normal">· {clientName}</span>}
            </h2>
            <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5 mt-3">
            {STEPS.map((s, i) => (
              <div key={s.n} className="flex items-center gap-1.5 flex-1">
                <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold shrink-0 ${
                  step === s.n ? 'bg-blue-600 text-white'
                  : step > s.n ? 'bg-blue-100 text-blue-700'
                  : 'bg-bg-2 text-ink-3'
                }`}>{s.n}</span>
                <span className={`text-xs font-medium ${step === s.n ? 'text-ink' : 'text-ink-3'}`}>{s.label}</span>
                {i < STEPS.length - 1 && <span className="flex-1 h-px bg-hairline" />}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
          {/* ── Step 1 · Who ───────────────────────────────────────────── */}
          {step === 1 && (<>
          {/* Client picker — only in standalone mode (Schedule page). When opened
              from a client profile the client is fixed and this is hidden. */}
          {standalone && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-ink-2 font-medium">Client *</label>
                <button type="button"
                  onClick={() => { setAddingClient(a => !a); setClientErr('') }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                  {addingClient ? 'Cancel' : '+ New client'}
                </button>
              </div>
              {!addingClient ? (
                <select value={activeClientId} onChange={e => selectClient(e.target.value)}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                  <option value="">Select a client…</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2">
                  <input autoFocus value={newClient.name} onChange={e => setNewClient(n => ({ ...n, name: e.target.value }))}
                    placeholder="Client name *"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newClient.phone} onChange={e => setNewClient(n => ({ ...n, phone: e.target.value }))}
                      placeholder="Phone"
                      className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                    <input value={newClient.email} onChange={e => setNewClient(n => ({ ...n, email: e.target.value }))}
                      placeholder="Email"
                      className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  </div>
                  {clientErr && <div className="text-xs text-red-600">{clientErr}</div>}
                  <button type="button" onClick={createInlineClient} disabled={creatingClient || !newClient.name.trim()}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                    {creatingClient ? 'Creating…' : 'Create & select client'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Property picker (filtered by client) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-ink-2 font-medium">Property</label>
              <button type="button"
                onClick={() => { setAddingProp(a => !a); setPropErr('') }}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                {addingProp ? 'Cancel' : '+ New property'}
              </button>
            </div>
            {!addingProp ? (
              <select
                value={form.property_id}
                onChange={onPropertyChange}
                data-testid="job-create-property-select"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
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
            ) : (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2">
                <input autoFocus value={newProp.name} onChange={e => setNewProp(n => ({ ...n, name: e.target.value }))}
                  placeholder="Property name * (e.g. 4 Red Barn Circle)"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                <input value={newProp.address} onChange={e => setNewProp(n => ({ ...n, address: e.target.value }))}
                  placeholder="Address"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                {propErr && <div className="text-xs text-red-600">{propErr}</div>}
                <button type="button" onClick={createInlineProperty} disabled={creatingProp || !newProp.name.trim()}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                  {creatingProp ? 'Creating…' : 'Create & select property'}
                </button>
              </div>
            )}
          </div>
          </>)}

          {/* ── Step 2 · What ──────────────────────────────────────────── */}
          {step === 2 && (<>
          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">Title *</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder={recurring ? 'e.g. Biweekly Home Clean' : 'e.g. Smith Residence — Deep Clean'}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">Service Type</label>
            <div className="flex gap-2">
              {JOB_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, job_type: t.value }))}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    form.job_type === t.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {form.job_type === 'str_turnover' && (
              <p className="text-[11px] text-ink-3 mt-1.5 leading-snug">
                Tip: STR turnovers can auto-schedule from an Airbnb/VRBO iCal feed. Set the property's type to STR on the client's Properties tab to add a feed.
              </p>
            )}
          </div>

          {/* Repeat toggle — drives the rest of the form. */}
          <div className="flex items-center justify-between bg-bg border border-hairline rounded-lg px-3 py-2.5">
            <label className="flex items-center gap-2 text-sm text-ink-2 font-medium cursor-pointer">
              <RepeatIcon className="w-4 h-4 text-ink-3" />
              Repeat
              <span className="text-xs text-ink-3 font-normal">
                {recurring ? '— recurring schedule' : '— one-time job'}
              </span>
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={recurring}
              onClick={() => setRecurring(r => !r)}
              data-testid="job-create-repeat-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                recurring ? 'bg-blue-600' : 'bg-bg-2'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-panel transition-transform ${
                  recurring ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          </>)}

          {/* ── Step 3 · When ──────────────────────────────────────────── */}
          {step === 3 && (<>
          {/* One-time mode: single Date */}
          {!recurring && (
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1">
                <Calendar className="w-3 h-3 inline mr-1" /> Date *
              </label>
              <input
                type="date"
                value={form.scheduled_date}
                onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              />
            </div>
          )}

          {/* Recurring mode: Frequency + Days/Day-of-month */}
          {recurring && (
            <>
              <div>
                <label className="block text-xs text-ink-2 font-medium mb-1">Frequency</label>
                <div className="grid grid-cols-2 gap-2">
                  {FREQUENCIES.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        frequency: opt.value,
                        interval_weeks: opt.interval ?? f.interval_weeks,
                        // Daily defaults to every day (no weekday filter); leaving
                        // daily restores a sensible default day for weekly modes.
                        days_of_week: opt.value === 'daily' ? []
                          : ((f.days_of_week || []).length ? f.days_of_week : [0]),
                      }))}
                      className={`py-2 rounded-lg text-xs font-medium transition-colors border ${
                        form.frequency === opt.value
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {form.frequency === 'monthly' ? (
                <div>
                  <label className="block text-xs text-ink-2 font-medium mb-1">Day of Month</label>
                  <input
                    type="number"
                    min="1"
                    max="28"
                    value={form.day_of_month || 1}
                    onChange={e => setForm(f => ({ ...f, day_of_month: parseInt(e.target.value) }))}
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                  <p className="text-[10px] text-ink-3 mt-1">1-28; months without a 29th/30th/31st are skipped automatically.</p>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-ink-2 font-medium mb-1">
                    {form.frequency === 'daily' ? 'Days (optional — blank = every day)' : 'Days of Week *'}
                  </label>
                  <div className="grid grid-cols-7 gap-1">
                    {WEEK_LABELS.map((d, i) => {
                      const selected = (form.days_of_week || []).includes(i)
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setForm(f => {
                            const cur = f.days_of_week || []
                            return {
                              ...f,
                              days_of_week: selected ? cur.filter(x => x !== i) : [...cur, i].sort(),
                            }
                          })}
                          className={`py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                            selected
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                          }`}
                        >
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-ink-2 font-medium mb-1">
                <Clock className="w-3 h-3 inline mr-1" /> Start *
              </label>
              <input
                type="time"
                value={form.start_time}
                onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-ink-2 font-medium mb-1">End *</label>
              <input
                type="time"
                value={form.end_time}
                onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">
              <MapPin className="w-3 h-3 inline mr-1" /> Address {recurring ? '*' : ''}
            </label>
            <input
              value={form.address}
              onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
              placeholder="123 Main St, Portland, ME"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          {recurring && (
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1">Generate ahead</label>
              <select
                value={form.generate_weeks_ahead}
                onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: parseInt(e.target.value) }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
              >
                {[4, 6, 8, 12, 16, 26].map(w => <option key={w} value={w}>{w} weeks</option>)}
              </select>
              <p className="text-[10px] text-ink-3 mt-1">How many weeks of Jobs to materialize from this schedule.</p>
            </div>
          )}

          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="Special instructions, access codes, etc."
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
          </>)}
        </div>

        <div className="p-6 border-t border-hairline flex items-center gap-3">
          <button
            onClick={step === 1 ? onClose : goBack}
            className={`${btn} bg-bg-2 text-ink-2 hover:bg-hairline`}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 3 ? (
            <button
              onClick={goNext}
              disabled={step === 1 ? !step1Valid : !step2Valid}
              data-testid="job-create-next"
              className={`${btn} flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed`}
            >
              Next
            </button>
          ) : (
            <button
              onClick={save}
              disabled={saving || !canSave}
              className={`${btn} flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed`}
            >
              {saving ? 'Creating...' : recurring ? 'Create & Generate Jobs' : 'Create Job'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
