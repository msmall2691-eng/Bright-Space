import { useState, useEffect } from 'react'
import { X, Calendar, Clock, MapPin, AlertCircle, Repeat as RepeatIcon, Search, Loader, Check, Users } from 'lucide-react'
import { get, post } from '../api'
import { toast } from '../utils/toastBus'
import { parseSimilarSeriesConflict } from '../utils/recurringDuplicates'
import AddressAutocomplete from './AddressAutocomplete'
import { toLocalYMD } from '../utils/format'
import { useEmployees } from '../hooks/useEmployees'
import { normalizeEmployee } from '../utils/employees'

// Where an in-progress booking is parked if the session expires mid-submit, so
// it can be restored after re-login instead of being silently lost.
const JOB_DRAFT_KEY = 'brightbase_job_draft'

const JOB_TYPES = [
  { value: 'residential',  label: 'Residential' },
  { value: 'deep_clean',   label: 'Deep Clean' },
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

/** "This slot conflicts" prompt with a one-click override. Shown when
 *  create_job returns a 409 (cleaner double-booked, time off, over capacity, or
 *  the slot is already busy on Google Calendar). Quiet hairline card + amber
 *  dot (the owner-vetoed pattern is a solid tinted banner) — matches
 *  components/schedule/OpsAlerts.jsx. */
function ConflictPrompt({ conflict, saving, onCancel, onOverride }) {
  if (!conflict) return null
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-hairline bg-panel text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-ink mb-1">Scheduling conflict</p>
        <p className="text-ink-2 mb-2">{conflict}</p>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 rounded-md bg-bg-2 border border-hairline-2 text-ink-2 hover:bg-hairline">Pick another time</button>
          <button type="button" onClick={onOverride} disabled={saving}
            className="px-3 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 font-medium disabled:opacity-50">
            {saving ? 'Booking…' : 'Book anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** "This client already has a similar series" prompt. Shown when
 *  POST /api/recurring 409s with detail=similar_series_exists (the backend's
 *  pre-create duplicate guard). Mirrors ConflictPrompt's escape-hatch UX:
 *  link to the existing series, or resubmit with allow_duplicate=true. */
function DuplicateSeriesPrompt({ matches, saving, onCancel, onOverride }) {
  if (!matches || !matches.length) return null
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-hairline bg-panel text-xs"
      data-testid="job-create-duplicate-series-prompt">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-ink mb-1">Similar recurring series already exists</p>
        <ul className="text-ink-2 mb-2 space-y-1">
          {matches.map(m => (
            <li key={m.id}>
              This client already has: {m.cadence}
              {m.property_name ? ` at ${m.property_name}` : m.address ? ` at ${m.address}` : ''}
              {` — ${m.upcoming_job_count || 0} upcoming`}
              {' · '}
              <a href={`/recurring?series=${m.id}`}
                className="font-medium underline text-ink hover:text-indigo-600">
                Open existing
              </a>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 rounded-md bg-bg-2 border border-hairline-2 text-ink-2 hover:bg-hairline">Never mind</button>
          <button type="button" onClick={onOverride} disabled={saving}
            className="px-3 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 font-medium disabled:opacity-50">
            {saving ? 'Creating…' : 'Create anyway'}
          </button>
        </div>
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
const JOB_DURATIONS = { residential: 180, deep_clean: 240, commercial: 180, str_turnover: 180 }

// Quick-schedule default date: the next business day (skip Sat/Sun), so a fast
// booking doesn't silently land on today.
function nextBusinessDay() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return toLocalYMD(d)
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
  initialFrequency = null,
  defaultRecurring = false,
  // Prefill the start time (and derive an end time from JOB_DURATIONS). Used
  // by the Week view's click-empty-slot handler so a new job seeded from a
  // 10:15 slot opens with 10:15 already picked, not the default 09:00.
  initialStartTime = null,
  onClose,
  onCreated,
}) {
  const [properties, setProperties] = useState([])
  const [loadingProps, setLoadingProps] = useState(false)
  const [recurring, setRecurring] = useState(defaultRecurring)
  const [icalUrl, setIcalUrl] = useState('')
  // Pre-fill the recurring cadence from the customer's stated frequency (carried
  // from the lead through the quote) so a won quote is one confirm away.
  const seedFreq = ['weekly', 'biweekly', 'monthly'].includes((initialFrequency || '').toLowerCase())
    ? initialFrequency.toLowerCase() : 'biweekly'
  const _seedStart = initialStartTime || '09:00'
  const [form, setForm] = useState({
    title: initialTitle || (clientName ? `${clientName} — Clean` : ''),
    job_type: initialJobType || 'residential',
    scheduled_date: initialDate || nextBusinessDay(),
    start_time: _seedStart,
    end_time: addMinutes(_seedStart, JOB_DURATIONS[initialJobType || 'residential'] || 180),
    address: '',
    notes: '',
    property_id: initialPropertyId ? String(initialPropertyId) : '',
    // Recurring-only fields
    frequency: seedFreq,
    interval_weeks: seedFreq === 'weekly' ? 1 : 2,
    days_of_week: [0],
    day_of_month: 1,
    generate_weeks_ahead: 8,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Audit finding: the modal used to switch between a compact form and a
  // completely different 3-step wizard when "Advanced options" was clicked.
  // Now everything is one form. `showMore` expands extra fields (property
  // picker + recurring options + address override) INLINE below the compact
  // form — no mode switch, no wizard. Defaults open when the caller wants
  // recurring so the recurring-config fields are immediately visible.
  const [showMore, setShowMore] = useState(!!defaultRecurring)
  const [showNotes, setShowNotes] = useState(false)
  // Once the user edits End by hand, stop auto-deriving it from Start + duration.
  const [endTouched, setEndTouched] = useState(false)

  // Assign the cleaner(s) right here at creation — no more "create, then open
  // the job to assign". Roster comes from the shared cached hook. The assigned
  // cleaners see the job on My Day; a double-booked cleaner surfaces the same
  // "Book anyway" conflict prompt as any other clash.
  const { employees } = useEmployees()
  const [cleanerIds, setCleanerIds] = useState([])
  const toggleCleaner = (id) => setCleanerIds(prev =>
    prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])

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
  // Crew-roster name set — used to badge client search results whose
  // name matches a cleaner (audit finding: "Megan Small" existed as both a
  // client and a cleaner and got confused in dispatch). Loaded lazily and
  // tolerates the roster fetch failing — an empty set just skips the badge.
  const [employeeNameSet, setEmployeeNameSet] = useState(() => new Set())
  useEffect(() => {
    if (!standalone) return
    get('/api/dispatch/employees')
      .then(rows => {
        const names = new Set()
        for (const e of (Array.isArray(rows) ? rows : [])) {
          const n = (e?.name || e?.displayName
            || [e?.firstName, e?.lastName].filter(Boolean).join(' ') || '').trim().toLowerCase()
          if (n) names.add(n)
        }
        setEmployeeNameSet(names)
      })
      .catch(() => setEmployeeNameSet(new Set()))
  }, [standalone])
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
      // Include lead-status clients — most of the client book starts as
      // leads (45/51 in July audit) and quietly filtering them out made
      // "New Job" unusable for the majority of records.
      const params = new URLSearchParams({ limit: '20' })
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
    if (Array.isArray(draft.cleanerIds)) setCleanerIds(draft.cleanerIds)
    if (typeof draft.recurring === 'boolean') setRecurring(draft.recurring)
    if (typeof draft.showMore === 'boolean') setShowMore(draft.showMore)
    else if (draft.quick === false) setShowMore(true)  // legacy drafts
    if (draft.client) { setSelectedClient(draft.client); setActiveClientId(String(draft.client.id)) }
    toast?.info?.('Restored your in-progress booking from before the session timed out.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Owner report: a client added with her address still showed "No properties
  // for this client yet", forcing a re-type. New clients now auto-create the
  // property server-side; for clients from before that change, this holds the
  // client's own address so the picker can offer creating it in one tap.
  const [clientAddress, setClientAddress] = useState(null)

  // Load the active client's properties whenever it changes.
  useEffect(() => {
    if (!activeClientId) { setProperties([]); setClientAddress(null); return }
    setLoadingProps(true)
    get(`/api/properties?client_id=${activeClientId}`)
      .then(data => {
        const list = Array.isArray(data) ? data : []
        setProperties(list)
        if (list.length === 0) {
          get(`/api/clients/${activeClientId}`).then(c => {
            if (!c?.address) return
            setClientAddress({ address: c.address, city: c.city, state: c.state, zip_code: c.zip_code })
            // The recurring form requires an address — prefill it from the
            // client card instead of making the operator re-type it.
            setForm(f => f.address ? f : { ...f, address: [c.address, c.city, c.state].filter(Boolean).join(', ') })
          }).catch(() => {})
        } else {
          setClientAddress(null)
        }
        if (initialPropertyId) {
          const prop = list.find(p => p.id === parseInt(initialPropertyId))
          if (prop) applyProperty(prop)
        } else if (list.length === 1 && !form.property_id) {
          // Auto-select the client's only property. Recurring form's
          // Address field is required — without this the user had to
          // manually re-type an address the system already knew, or the
          // Save button stayed disabled (audit finding). Only fires when
          // no property is already picked so re-loading doesn't clobber.
          applyProperty(list[0])
        } else if (!form.address && list.length > 0) {
          // Multi-property client without a picked property: prefill the
          // Address from the first property so the required field is
          // populated. User can still choose a specific property to
          // override, which will re-apply that property's address.
          const firstWithAddress = list.find(p => p.address) || list[0]
          if (firstWithAddress?.address) {
            setForm(f => ({ ...f, address: [firstWithAddress.address, firstWithAddress.city, firstWithAddress.state].filter(Boolean).join(', ') }))
          }
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

  // Open the inline create-client form pre-filled with whatever the operator
  // already typed in the search box — the Twenty/Google "type a name that
  // doesn't exist → Create it" pattern, so an unknown customer is one tap, not
  // a retype. Split a "First Last" query into the name field as-is (backend
  // derives first/last); phone/email stay optional.
  const beginCreateClient = (prefillName = '') => {
    setNewClient(n => ({ ...n, name: prefillName || n.name || '' }))
    setClientErr('')
    setAddingClient(true)
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
        // Job types and property types are different vocabularies: the job is
        // 'str_turnover' but the PROPERTY is 'str' (ck_properties_property_type
        // allows only residential|commercial|str). The old mapping passed the
        // job type through verbatim, so creating a property from a turnover
        // job hit the CHECK constraint and 500'd. A deep clean is a
        // residential property; only the JOB is priced as deep.
        property_type: (form.job_type === 'str_turnover' || form.job_type === 'str') ? 'str'
          : form.job_type === 'commercial' ? 'commercial'
          : 'residential',
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

  // One-tap version of the above for the "client has an address but no
  // property yet" case — creates the property straight from the client card.
  const createPropertyFromClientAddress = async () => {
    if (!clientAddress?.address) return
    setCreatingProp(true); setPropErr('')
    try {
      const created = await post('/api/properties', {
        client_id: parseInt(activeClientId),
        name: clientAddress.address,
        address: clientAddress.address,
        city: clientAddress.city || undefined,
        state: clientAddress.state || undefined,
        zip_code: clientAddress.zip_code || undefined,
        property_type: (form.job_type === 'str_turnover' || form.job_type === 'str') ? 'str'
          : form.job_type === 'commercial' ? 'commercial'
          : 'residential',
      })
      setProperties([created])
      applyProperty(created)
      setClientAddress(null)
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
  // Recurring twin of `conflict`: matches from the backend's similar-series
  // 409 (create-duplicate guard), surfaced as an "Open existing / Create
  // anyway" prompt rather than a dead-end error.
  const [dupMatches, setDupMatches] = useState(null)

  const save = async (allowConflicts = false, allowDuplicate = false) => {
    setSaving(true)
    setError(null)
    setConflict(null)
    setDupMatches(null)
    // Park the booking before we hit the network: if the session has expired,
    // the 401 redirects to /login (this code never resumes), and this draft is
    // what gets restored after re-auth. Cleared on a confirmed success below.
    try {
      localStorage.setItem(JOB_DRAFT_KEY, JSON.stringify({
        form, recurring, showMore, cleanerIds,
        client: selectedClient
          ? { id: selectedClient.id, name: selectedClient.name, email: selectedClient.email }
          : null,
      }))
    } catch { /* storage unavailable — proceed without a draft */ }
    // Best-effort: an Airbnb/VRBO calendar pasted into the STR field above
    // attaches to the property once the job/series is confirmed. A failure
    // here shouldn't undo or block the job that already saved successfully —
    // the office can still add it later from the property, same as today.
    const saveIcalIfNeeded = async () => {
      if (!icalUrl.trim() || !form.property_id) return
      try { await post(`/api/properties/${form.property_id}/icals`, { url: icalUrl.trim() }) }
      catch (e) { console.error('[JobCreateModal] could not save the iCal feed', e) }
    }
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
          cleaner_ids: cleanerIds,
          notes: form.notes || null,
          // Link back to the source quote so it's converted (see one-time path).
          quote_id: initialQuoteId ? parseInt(initialQuoteId) : null,
          // Similar-series guard override — only true from "Create anyway".
          allow_duplicate: allowDuplicate,
        }
        const sched = await post('/api/recurring', body)
        if (!sched) return  // 401 → redirecting to /login; keep the draft to restore
        try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
        await saveIcalIfNeeded()
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
        cleaner_ids: cleanerIds,
        // When scheduling from an accepted quote, link the job back so the
        // backend converts the quote and revenue→job traceability is kept.
        quote_id: initialQuoteId ? parseInt(initialQuoteId) : null,
        allow_conflicts: allowConflicts,
      }
      const job = await post('/api/jobs', body)
      if (!job) return  // 401 → redirecting to /login; keep the draft to restore
      try { localStorage.removeItem(JOB_DRAFT_KEY) } catch { /* ignore */ }
      await saveIcalIfNeeded()
      onCreated?.({ kind: 'job', job, gcal: job?.gcal })
      onClose?.()
    } catch (e) {
      // Recurring 409 from the similar-series guard → "Open existing / Create
      // anyway" prompt (overridable via allow_duplicate, like allow_conflicts).
      const similar = recurring ? parseSimilarSeriesConflict(e) : null
      if (similar) {
        setDupMatches(similar)
        return
      }
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

  // Bumped from py-2.5 → py-3 so the button is ~44px tall on phones (Apple HIG
  // minimum touch target). Same visual on desktop, no layout shift.
  const btn = "px-4 py-3 min-h-[44px] rounded-lg text-sm font-medium transition-colors"

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center sm:justify-end"
      data-testid="job-create-modal"
      onClick={handleCancel}
    >
      <div
        className="w-full sm:w-[420px] bg-panel rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh] sm:max-h-[95dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile-only drag handle — signals dismissible bottom sheet. */}
        <div className="sm:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-ink-3/30" aria-hidden="true" />
        </div>
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
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain p-6 space-y-4 scrollbar-thin">
          {/* Client picker — only in standalone mode; from a client profile
              the client is fixed by the caller. */}
          {standalone && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-ink-2 font-medium">Client *</label>
                <button type="button"
                  onClick={() => { addingClient ? setAddingClient(false) : beginCreateClient(clientQuery.trim()); setClientErr('') }}
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                  {addingClient ? 'Cancel' : '+ New client'}
                </button>
              </div>
              {!addingClient ? (
                selectedClient ? (
                  // A client is chosen — show it as a chip with a "Change" affordance.
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2">
                    <span className="flex items-center gap-2 min-w-0 text-sm text-ink">
                      <Check className="w-4 h-4 text-indigo-600 shrink-0" />
                      <span className="truncate font-medium">{selectedClient.name}</span>
                      {selectedClient.email && <span className="truncate text-xs text-ink-3">· {selectedClient.email}</span>}
                    </span>
                    <button type="button" onClick={clearClient}
                      className="text-xs text-indigo-600 hover:text-indigo-700 font-medium shrink-0">Change</button>
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
                            className="text-indigo-600 hover:text-indigo-700 font-medium shrink-0">Retry</button>
                        </div>
                      ) : clientResults.length === 0 ? (
                        clientQuery.trim() ? (
                          // Inline create-on-no-match: the typed name becomes a
                          // one-tap "Create it" instead of a dead end + retype.
                          <button type="button" onClick={() => beginCreateClient(clientQuery.trim())}
                            data-testid="job-create-client-create-inline"
                            className="w-full flex items-center gap-2 px-3 py-3 text-sm text-left hover:bg-bg transition-colors">
                            <span className="w-6 h-6 rounded-full bg-indigo-500/10 text-indigo-600 flex items-center justify-center shrink-0 text-base leading-none">+</span>
                            <span className="min-w-0">
                              <span className="font-semibold text-indigo-700 dark:text-indigo-300">Create “{clientQuery.trim()}”</span>
                              <span className="block text-[11px] text-ink-3">Add as a new client and select</span>
                            </span>
                          </button>
                        ) : (
                          <div className="px-3 py-4 text-xs text-ink-3 text-center">
                            No active clients yet
                            <span className="block mt-0.5">Type a name above to create one.</span>
                          </div>
                        )
                      ) : (
                        clientResults.map(c => {
                          // Warn when this client's name matches a crew-roster
                          // name — they're often two different people
                          // ("Megan Small" the client vs the cleaner) and picking
                          // the wrong one confuses dispatch. Case-insensitive
                          // exact-match keeps the false-positive rate low.
                          const namesCollide = employeeNameSet.has((c.name || '').trim().toLowerCase())
                          return (
                            <button key={c.id} type="button" onClick={() => chooseClient(c)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors">
                              <div className="font-medium text-ink truncate flex items-center gap-1.5">
                                <span className="truncate">{c.name}</span>
                                {namesCollide && (
                                  <span
                                    title="Same name as a cleaner on your crew roster — confirm this is the customer, not the crew."
                                    className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                                  >
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
                                    Also a cleaner
                                  </span>
                                )}
                              </div>
                              {(c.email || c.phone) && (
                                <div className="text-[11px] text-ink-3 truncate">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                              )}
                            </button>
                          )
                        })
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
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                    {creatingClient ? 'Creating…' : 'Create & select client'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Always-visible compact form: Service Type → Date → Start/End → Notes.
              "More options" below inline-expands the property picker, address
              override, and recurring options. No more mode switching between a
              compact form and a separate 3-step wizard (audit finding). */}
          {!standalone && clientName && (
            <div className="text-xs text-ink-3">Scheduling for <span className="font-medium text-ink-2">{clientName}</span></div>
          )}
          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">Service type</label>
            <div className="flex gap-2">
              {JOB_TYPES.map(t => (
                <button key={t.value} type="button" onClick={() => setJobType(t.value)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    form.job_type === t.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                  }`}>{t.label}</button>
              ))}
            </div>
          </div>
          {/* Date field: hidden when recurring is on (the recurring section below
              owns frequency/day-of-week scheduling instead of a single date). */}
          {!recurring && (
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1"><Calendar className="w-3 h-3 inline mr-1" /> Date *</label>
              <input type="date" value={form.scheduled_date} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
          )}
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

          {/* Cleaner — assign right at booking (optional). STR turnovers can be
              left open for someone to claim, so this never blocks Save. */}
          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">
              <Users className="w-3 h-3 inline mr-1" /> Cleaner
              <span className="text-ink-3 font-normal ml-1">
                · {cleanerIds.length ? `${cleanerIds.length} assigned` : 'optional'}
              </span>
            </label>
            {employees.length === 0 ? (
              <p className="text-xs text-ink-3">No cleaners on the roster yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {employees.map(e => {
                  // Normalize the mixed roster shape ({id,name} vs the legacy
                  // {userId,firstName,...}) — a bare String(e.id) would save
                  // 'undefined' for legacy-shaped rows.
                  const { id, name } = normalizeEmployee(e)
                  if (!id) return null
                  const on = cleanerIds.includes(id)
                  return (
                    <button key={id} type="button" onClick={() => toggleCleaner(id)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        on ? 'bg-indigo-600 text-white border-indigo-600'
                           : 'bg-panel text-ink-2 border-hairline hover:bg-bg'}`}>
                      {on && <Check className="w-3 h-3" />}
                      {name}
                    </button>
                  )
                })}
              </div>
            )}
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
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">+ Add notes</button>
          )}

          {/* More options — inline expansion, NOT a mode switch. Reveals the
              property picker, title override, repeat/recurring options, and
              address override, right below the compact form on the same page. */}
          <button type="button" onClick={() => setShowMore(v => !v)}
            className="w-full flex items-center justify-center gap-1.5 text-center text-xs text-ink-3 hover:text-ink-2 pt-1 border-t border-hairline mt-1">
            More options (property, recurring, address)
            <span className={`transition-transform inline-block ${showMore ? 'rotate-180' : ''}`}>▾</span>
          </button>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded-lg px-3 py-2.5 text-xs">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <ConflictPrompt conflict={conflict} saving={saving}
            onCancel={() => setConflict(null)} onOverride={() => save(true)} />
          <DuplicateSeriesPrompt matches={dupMatches} saving={saving}
            onCancel={() => setDupMatches(null)} onOverride={() => save(false, true)} />

          {/* ── More options — Property picker (inline expansion) ─────────── */}
          {showMore && (<>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-ink-2 font-medium">Property</label>
              <button type="button"
                onClick={() => { setAddingProp(a => !a); setPropErr('') }}
                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                {addingProp ? 'Cancel' : '+ New property'}
              </button>
            </div>
            {!addingProp ? (
              <select
                value={form.property_id}
                onChange={onPropertyChange}
                data-testid="job-create-property-select"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 disabled:bg-bg-2 disabled:text-ink-3"
                disabled={loadingProps || !activeClientId}
              >
                <option value="">
                  {!activeClientId
                    ? 'Pick a client first'
                    : loadingProps
                      ? 'Loading properties...'
                      : properties.length === 0
                        ? 'No properties for this client yet'
                        : 'Select a property (optional)'}
                </option>
                {properties.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.address ? ` — ${p.address}` : ''}
                  </option>
                ))}
              </select>
            ) : null}
            {!addingProp && !loadingProps && properties.length === 0 && clientAddress?.address && (
              <button type="button" onClick={createPropertyFromClientAddress} disabled={creatingProp}
                data-testid="job-create-use-client-address"
                className="mt-1.5 text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50">
                {creatingProp ? 'Creating…' : `Use their address — create “${clientAddress.address}”`}
              </button>
            )}
            {addingProp && (
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
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                  {creatingProp ? 'Creating…' : 'Create & select property'}
                </button>
              </div>
            )}
          </div>

          {/* Title override (auto-generated from the client name; edit here
              to override). Service Type stays in the compact form above so
              it isn't duplicated. */}
          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">Title (optional)</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder={recurring ? 'e.g. Biweekly Home Clean' : 'e.g. Smith Residence — Deep Clean'}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>

          {/* Repeat toggle — drives whether the compact Date field above is
              replaced by frequency/day-of-week options below. */}
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
                recurring ? 'bg-indigo-600' : 'bg-bg-2'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-panel transition-transform ${
                  recurring ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Airbnb/VRBO calendar — only makes sense once there's a real
              short-term-rental property to attach it to. Folds iCal setup
              into the same moment the office already picked one-time vs
              recurring, instead of a separate destination they'd have to
              already know exists (property edit -> Calendar Feeds). */}
          {form.job_type === 'str_turnover' && form.property_id && (
            <div>
              <label className="block text-xs text-ink-2 font-medium mb-1">
                Airbnb / VRBO calendar <span className="text-ink-3 font-normal">(optional)</span>
              </label>
              <input
                type="url"
                value={icalUrl}
                onChange={e => setIcalUrl(e.target.value)}
                placeholder="Paste the calendar export URL from Airbnb or VRBO"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              />
              <p className="text-[11px] text-ink-3 mt-1">
                Keeps future bookings in sync automatically — add it now or later from the property.
              </p>
            </div>
          )}

          {/* Recurring scheduling options — only when Repeat is on. The
              compact Date field above hides in recurring mode; these
              frequency/day-of-week/etc controls take over. */}
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
                          ? 'bg-indigo-600 text-white border-indigo-600'
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
                              ? 'bg-indigo-600 text-white border-indigo-600'
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

          {/* Address override — pre-fills from the selected property/client
              elsewhere. Only exposed here for when the operator needs to
              deviate (e.g. a one-off job at a different address). */}
          <div>
            <label className="block text-xs text-ink-2 font-medium mb-1">
              <MapPin className="w-3 h-3 inline mr-1" /> Address {recurring ? '*' : '(optional)'}
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
              <label className="block text-xs text-ink-2 font-medium mb-1">Keep visits scheduled ahead</label>
              <select
                value={form.generate_weeks_ahead}
                onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: parseInt(e.target.value) }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none"
              >
                {[4, 6, 8, 12, 16, 26].map(w => <option key={w} value={w}>{w} weeks</option>)}
              </select>
              <p className="text-[10px] text-ink-3 mt-1">Weeks of visits created at a time — rolled forward daily by Recurring auto-generate. Not the repeat interval.</p>
            </div>
          )}
          </>)}
        </div>

        <div
          className="p-6 border-t border-hairline flex items-center gap-3"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}
        >
          <button onClick={handleCancel} className={`${btn} bg-bg-2 text-ink-2 hover:bg-hairline`}>Cancel</button>
          <button
            onClick={() => save()}
            disabled={saving || !canSave}
            data-testid="job-create-submit"
            className={`${btn} flex-1 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed`}
          >
            {saving
              ? (recurring ? 'Creating…' : 'Creating…')
              : (recurring ? 'Create & Generate Jobs' : 'Create job')}
          </button>
        </div>
      </div>
    </div>
  )
}
