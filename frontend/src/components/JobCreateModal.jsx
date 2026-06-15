import { useState, useEffect } from 'react'
import { X, Calendar, Clock, MapPin, AlertCircle, Repeat as RepeatIcon, Search, Loader, Check } from 'lucide-react'
import { get, post } from '../api'
import { toast } from '../utils/toastBus'
import AddressAutocomplete from './AddressAutocomplete'

// Where an in-progress booking is parked if the session expires mid-submit, so
// it can be restored after re-login instead of being silently lost.
const JOB_DRAFT_KEY = 'brightbase_job_draft'

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

/** Amber "this slot conflicts" prompt with a one-click override. Shown when
 *  create_job returns a 409 (cleaner double-booked, time off, over capacity, or
 *  the slot is already busy on Google Calendar). */
function ConflictPrompt({ conflict, saving, onCancel, onOverride }) {
  if (!conflict) return null
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs">
      <p className="font-semibold text-amber-800 mb-1">Scheduling conflict</p>
      <p className="text-amber-900 mb-2">{conflict}</p>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 rounded-md bg-bg-2 text-ink-2 hover:bg-hairline">Pick another time</button>
        <button type="button" onClick={onOverride} disabled={saving}
          className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
          {saving ? 'Booking…' : 'Book anyway'}
        </button>
      </div>
    </div>
  )
}

function jobTypeFromProperty(propertyType) {
  const t = (propertyType || '').toLowerCase()
  if (t === 'commercial') return 'commercial'
  if (t === 'str') return 'str_turnover'
  return 'residential'
}

// Default visit length per service type (minutes); drives the auto-filled End.
const JOB_DURATIONS = { residential: 180, commercial: 180, str_turnover: 180 }

// Quick-schedule default date: the next business day (skip Sat/Sun), so a fast
// booking doesn't silently land on today.
function nextBusinessDay() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

// "09:00" + minutes → "12:00" (24h, wraps within a day).
function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number)
  const total = ((h * 60 + m + mins) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
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
  initialQuoteId = null,
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
    scheduled_date: initialDate || nextBusinessDay(),
    start_time: '09:00',
    end_time: addMinutes('09:00', JOB_DURATIONS[initialJobType || 'residential'] || 180),
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
  // Quick-schedule: a single compact form is the default for the common path.
  // "Advanced" reveals the full stepped wizard (property, recurring, address).
  const [quick, setQuick] = useState(!defaultRecurring)
  const [showNotes, setShowNotes] = useState(false)
  // Once the user edits End by hand, stop auto-deriving it from Start + duration.
  const [endTouched, setEndTouched] = useState(false)

  const setStartTime = (v) => setForm(f => ({
    ...f, start_time: v,
    end_time: endTouched ? f.end_time : addMinutes(v, JOB_DURATIONS[f.job_type] || 180),
  }))
  const setEndTime = (v) => { setEndTouched(true); setForm(f => ({ ...f, end_time: v })) }
  const setJobType = (v) => setForm(f => ({
    ...f, job_type: v,
    end_time: endTouched ? f.end_time : addMinutes(f.start_time, JOB_DURATIONS[v] || 180),
  }))
  // Inline "new property" quick-add (a client may have none yet).
  const [addingProp, setAddingProp] = useState(false)
  const [newProp, setNewProp] = useState({ name: '', address: '' })
  const [creatingProp, setCreatingProp] = useState(false)
  const [propErr, setPropErr] = useState('')

  // Standalone mode (opened from the Schedule page, not a client): pick the
  // client here. When clientId is passed in (from a client profile) it's fixed.
  const standalone = !clientId
  const [activeClientId, setActiveClientId] = useState(clientId ? String(clientId) : '')
  const [selectedClient, setSelectedClient] = useState(null)
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')
  // Searchable typeahead state (replaces the old preload-everything dropdown,
  // which silently 422'd on limit=1000 and rendered empty).
  const [clientQuery, setClientQuery] = useState('')
  const [clientResults, setClientResults] = useState([])
  const [clientLoading, setClientLoading] = useState(false)
  const [clientLoadErr, setClientLoadErr] = useState('')
  const [clientRetry, setClientRetry] = useState(0)

  // In standalone mode, search the client list as the user types. Empty query
  // loads the most recent 20 so the list is never blank on open. Debounced;
  // surfaces explicit loading / empty / error states (never a silent empty).
  useEffect(() => {
    if (!standalone || selectedClient || addingClient) return
    const q = clientQuery.trim()
    const t = setTimeout(() => {
      setClientLoading(true); setClientLoadErr('')
      const params = new URLSearchParams({ status: 'active', limit: '20' })
      if (q) params.append('search', q)
      get(`/api/clients?${params.toString()}`)
        .then(d => setClientResults(Array.isArray(d) ? d : []))
        .catch(e => { setClientLoadErr(e?.message || 'Could not load clients'); setClientResults([]) })
        .finally(() => setClientLoading(false))
    }, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [standalone, selectedClient, addingClient, clientQuery, clientRetry])

  // One-shot restore: if a prior submit hit an expired session, the booking was
  // parked in localStorage (see save()). Bring it back so no work is lost. Only
  // in standalone mode (the Schedule "New Job" flow).
  useEffect(() => {
    if (!standalone) return
    let draft = null
    try { draft = JSON.parse(localStorage.getItem(JOB_DRAFT_KEY) || 'null') } catch { draft = null }
    if (!draft) return
    try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
    if (draft.form) setForm(draft.form)
    if (typeof draft.recurring === 'boolean') setRecurring(draft.recurring)
    if (typeof draft.quick === 'boolean') setQuick(draft.quick)
    if (draft.client) { setSelectedClient(draft.client); setActiveClientId(String(draft.client.id)) }
    toast?.info?.('Restored your in-progress booking from before the session timed out.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const chooseClient = (c) => {
    if (!c) return
    setActiveClientId(String(c.id))
    setSelectedClient(c)
    // Reset everything tied to the *previous* client's property — otherwise a
    // stale property_id/address/job_type could save a job for the new client
    // pointing at the old client's property (the endpoints don't cross-check).
    setProperties([])
    setAddingProp(false)
    setForm(f => ({
      ...f,
      property_id: '',
      job_type: 'residential',
      address: [c.address, c.city, c.state].filter(Boolean).join(', '),
      // Keep a user-typed title; otherwise default to the client's name.
      title: (!f.title || /—\s*Clean$/.test(f.title)) ? `${c.name} — Clean` : f.title,
    }))
  }

  const clearClient = () => {
    setActiveClientId('')
    setSelectedClient(null)
    setClientQuery('')
    setProperties([])
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
      chooseClient(created)
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

  // A 409 from create_job means a scheduling conflict (cleaner double-booked,
  // time off, over capacity, or the slot is already busy on Google Calendar).
  // The backend accepts allow_conflicts to override, so we surface a "Book
  // anyway" prompt rather than a dead-end error.
  const [conflict, setConflict] = useState(null)

  const save = async (allowConflicts = false) => {
    setSaving(true)
    setError(null)
    setConflict(null)
    // Park the booking before we hit the network: if the session has expired,
    // the 401 redirects to /login (this code never resumes), and this draft is
    // what gets restored after re-auth. Cleared on a confirmed success below.
    try {
      localStorage.setItem(JOB_DRAFT_KEY, JSON.stringify({
        form, recurring, quick,
        client: selectedClient
          ? { id: selectedClient.id, name: selectedClient.name, email: selectedClient.email }
          : null,
      }))
    } catch { /* storage unavailable — proceed without a draft */ }
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
          // Link back to the source quote so it's converted (see one-time path).
          quote_id: initialQuoteId ? parseInt(initialQuoteId) : null,
        }
        const sched = await post('/api/recurring', body)
        if (!sched) return  // 401 → redirecting to /login; keep the draft to restore
        try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
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
        // When scheduling from an accepted quote, link the job back so the
        // backend converts the quote and revenue→job traceability is kept.
        quote_id: initialQuoteId ? parseInt(initialQuoteId) : null,
        allow_conflicts: allowConflicts,
      }
      const job = await post('/api/jobs', body)
      if (!job) return  // 401 → redirecting to /login; keep the draft to restore
      try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
      onCreated?.({ kind: 'job', job, gcal: job?.gcal })
      onClose?.()
    } catch (e) {
      const msg = e?.message || `Failed to create ${recurring ? 'schedule' : 'job'}`
      // Conflict 409s (incl. the Google Free/Busy "already booked" guard) are
      // overridable — route them to the "Book anyway" prompt, not a hard error.
      if (!recurring && /conflict|unavailable|over capacity|time off|already booked/i.test(msg)) {
        setConflict(msg)
      } else {
        setError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  // Explicit dismissal abandons any parked draft so it isn't restored next open.
  const handleCancel = () => {
    try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
    onClose?.()
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
            <button onClick={handleCancel} className="text-ink-3 hover:text-ink" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Step indicator — advanced wizard only */}
          {!quick && (
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
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
          {/* Client picker — quick mode, or step 1 of the advanced wizard.
              Only in standalone mode; from a client profile the client is fixed. */}
          {standalone && (quick || step === 1) && (
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
                selectedClient ? (
                  // A client is chosen — show it as a chip with a "Change" affordance.
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2">
                    <span className="flex items-center gap-2 min-w-0 text-sm text-ink">
                      <Check className="w-4 h-4 text-blue-600 shrink-0" />
                      <span className="truncate font-medium">{selectedClient.name}</span>
                      {selectedClient.email && <span className="truncate text-xs text-ink-3">· {selectedClient.email}</span>}
                    </span>
                    <button type="button" onClick={clearClient}
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium shrink-0">Change</button>
                  </div>
                ) : (
                  <div>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3 pointer-events-none" />
                      <input
                        autoFocus
                        value={clientQuery}
                        onChange={e => setClientQuery(e.target.value)}
                        placeholder="Search clients by name, email, or phone…"
                        data-testid="job-create-client-search"
                        className="w-full bg-panel border border-hairline rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                      />
                    </div>
                    <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-hairline divide-y divide-hairline scrollbar-thin">
                      {clientLoading ? (
                        <div className="flex items-center justify-center gap-2 py-4 text-xs text-ink-3">
                          <Loader className="w-4 h-4 animate-spin" /> Searching…
                        </div>
                      ) : clientLoadErr ? (
                        <div className="flex items-center justify-between gap-2 px-3 py-3 text-xs">
                          <span className="text-red-600 truncate">{clientLoadErr}</span>
                          <button type="button" onClick={() => setClientRetry(n => n + 1)}
                            className="text-blue-600 hover:text-blue-700 font-medium shrink-0">Retry</button>
                        </div>
                      ) : clientResults.length === 0 ? (
                        <div className="px-3 py-4 text-xs text-ink-3 text-center">
                          {clientQuery.trim() ? 'No matching clients' : 'No active clients yet'}
                          <span className="block mt-0.5">Use “+ New client” to add one.</span>
                        </div>
                      ) : (
                        clientResults.map(c => (
                          <button key={c.id} type="button" onClick={() => chooseClient(c)}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors">
                            <div className="font-medium text-ink truncate">{c.name}</div>
                            {(c.email || c.phone) && (
                              <div className="text-[11px] text-ink-3 truncate">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )
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

          {/* ── Quick schedule · one screen (client above) ──────────────── */}
          {quick && (<>
            {!standalone && clientName && (
              <div className="text-xs text-ink-3">Scheduling for <span className="font-medium text-ink-2">{clientName}</span></div>
            )}
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1">Service type</label>
              <div className="flex gap-2">
                {JOB_TYPES.map(t => (
                  <button key={t.value} type="button" onClick={() => setJobType(t.value)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                      form.job_type === t.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                    }`}>{t.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1"><Calendar className="w-3 h-3 inline mr-1" /> Date *</label>
              <input type="date" value={form.scheduled_date} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-ink-2 font-medium mb-1"><Clock className="w-3 h-3 inline mr-1" /> Start *</label>
                <input type="time" value={form.start_time} onChange={e => setStartTime(e.target.value)}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-ink-2 font-medium mb-1">End *</label>
                <input type="time" value={form.end_time} onChange={e => setEndTime(e.target.value)}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>
            {showNotes ? (
              <div>
                <label className="block text-xs text-ink-2 font-medium mb-1">Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                  placeholder="Special instructions, access codes, etc."
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              </div>
            ) : (
              <button type="button" onClick={() => setShowNotes(true)}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add notes</button>
            )}
            <button type="button" onClick={() => setQuick(false)}
              className="w-full text-center text-xs text-ink-3 hover:text-ink-2 pt-1 border-t border-hairline mt-1">
              Advanced options (property, recurring, address)…
            </button>
            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            )}
            <ConflictPrompt conflict={conflict} saving={saving}
              onCancel={() => setConflict(null)} onOverride={() => save(true)} />
          </>)}

          {/* ── Advanced · Property (step 1; client handled above) ───────── */}
          {!quick && step === 1 && (
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
                <AddressAutocomplete
                  value={newProp.address}
                  onChange={v => setNewProp(n => ({ ...n, address: v }))}
                  onSelect={p => setNewProp(n => ({ ...n, address: p.address || n.address }))}
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
          )}

          {/* ── Step 2 · What ──────────────────────────────────────────── */}
          {!quick && step === 2 && (<>
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
                  onClick={() => setJobType(t.value)}
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
          {!quick && step === 3 && (<>
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
                onChange={e => setStartTime(e.target.value)}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-ink-2 font-medium mb-1">End *</label>
              <input
                type="time"
                value={form.end_time}
                onChange={e => setEndTime(e.target.value)}
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
          <ConflictPrompt conflict={conflict} saving={saving}
            onCancel={() => setConflict(null)} onOverride={() => save(true)} />
          </>)}
        </div>

        <div className="p-6 border-t border-hairline flex items-center gap-3">
          {quick ? (
            <>
              <button onClick={handleCancel} className={`${btn} bg-bg-2 text-ink-2 hover:bg-hairline`}>Cancel</button>
              <button
                onClick={() => save()}
                disabled={saving || !canSave}
                data-testid="job-create-submit"
                className={`${btn} flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed`}
              >
                {saving ? 'Creating…' : 'Create job'}
              </button>
            </>
          ) : (<>
          <button
            onClick={step === 1 ? handleCancel : goBack}
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
              onClick={() => save()}
              disabled={saving || !canSave}
              className={`${btn} flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed`}
            >
              {saving ? 'Creating...' : recurring ? 'Create & Generate Jobs' : 'Create Job'}
            </button>
          )}
          </>)}
        </div>
      </div>
    </div>
  )
}
