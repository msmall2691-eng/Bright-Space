import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, Trash2, X, Calendar, CheckCircle, Send, Mail, MessageSquare, Eye, ChevronDown, ChevronRight, Copy, Check, FileText, Search } from 'lucide-react'
import SavedViewsBar from '../components/SavedViewsBar'
import InlineSelect from '../components/InlineSelect'
import JobCreateModal from '../components/JobCreateModal'
import QuotePreview from '../components/QuotePreview'
import AddressAutocomplete from '../components/AddressAutocomplete'
import { CustomFieldsForm } from '../components/CustomFields'
import { get, post, patch, put, del } from "../api"
import { formatDate } from '../utils/format'


const QUOTE_STATUS_COLORS = {
  draft:    'bg-bg-2 text-ink-3 border-hairline',
  sent:     'bg-blue-50 text-blue-700 border-blue-200',
  viewed:   'bg-indigo-50 text-indigo-700 border-indigo-200',
  changes_requested: 'bg-amber-50 text-amber-700 border-amber-200',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  converted: 'bg-teal-50 text-teal-700 border-teal-200',
  declined: 'bg-red-50 text-red-700 border-red-200',
}

const LEAD_STATUS_COLORS = {
  new:       'bg-amber-50 text-amber-700 border-amber-200',
  reviewed:  'bg-blue-50 text-blue-700 border-blue-200',
  quoted:    'bg-purple-50 text-purple-700 border-purple-200',
  converted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

// Inline-edit status options (Twenty-style chips) for the leads/quotes tables.
const QUOTE_STATUS_OPTIONS = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'converted']
  .map(s => ({ value: s, label: s, chipClass: QUOTE_STATUS_COLORS[s] || QUOTE_STATUS_COLORS.draft }))
const LEAD_STATUS_OPTIONS = ['new', 'reviewed', 'quoted', 'converted']
  .map(s => ({ value: s, label: s, chipClass: LEAD_STATUS_COLORS[s] }))

// Guided "next step" per quote status — turns the quotes list into a worklist so
// it's always obvious what moves a lead toward becoming a (recurring) client.
const QUOTE_NEXT_STEP = {
  draft:             { text: 'Next: send it to the customer', cls: 'text-blue-600' },
  sent:              { text: 'Next: waiting on the customer — nudge if it goes quiet', cls: 'text-ink-3' },
  viewed:            { text: 'Next: they opened it — follow up to close', cls: 'text-blue-600' },
  changes_requested: { text: 'Next: revise and resend', cls: 'text-amber-600' },
  accepted:          { text: 'Next: schedule the job', cls: 'text-emerald-600' },
  declined:          { text: 'Next: follow up or archive', cls: 'text-ink-3' },
  converted:         { text: 'Won ✓ — set up a recurring plan to keep them', cls: 'text-emerald-600' },
}

const SERVICE_TYPES = ['residential', 'commercial', 'str']
const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

// Customer-facing label for a service type.
const serviceLabel = (t) => t === 'str' ? 'STR / Vacation rental cleaning'
  : `${(t || 'residential').charAt(0).toUpperCase()}${(t || 'residential').slice(1)} cleaning`
// Friendly cadence label, or '' when one-time / unknown.
const freqLabel = (f) => {
  const map = { weekly: 'Weekly', biweekly: 'Biweekly', 'bi-weekly': 'Biweekly',
    monthly: 'Monthly', 'one-time': '', onetime: '', once: '' }
  const key = (f || '').toLowerCase().trim()
  return map[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : '')
}
// Default customer-facing scope per service type — a sensible starting point
// the admin can edit. Keeps the quote from going out with an empty "what's
// included" section.
const SERVICE_SCOPE = {
  residential: 'Full home cleaning: kitchen, bathrooms, bedrooms, and living areas — dusting, vacuuming, mopping, and surface sanitizing. Trash removed and floors finished throughout.',
  commercial: 'Commercial cleaning of all common and work areas: restrooms, break areas, floors, and high-touch surfaces sanitized. Trash removed and entryways finished.',
  str: 'Turnover clean between guests: full kitchen and bathroom reset, fresh linens and towels staged, floors cleaned, trash removed, and the space restocked and guest-ready.',
}
// Build a quote title from a lead/request: "Biweekly Residential Cleaning — 24 Pine Street".
const titleFromIntake = (intake) => {
  const freq = freqLabel(intake.frequency)
  const svc = serviceLabel(intake.service_type)
  const where = (intake.address || intake.property_name || intake.city || '').split(',')[0].trim()
  const lead = [freq, svc].filter(Boolean).join(' ')
  return where ? `${lead} — ${where}` : lead
}
// Round to the nearest $5 — matches the website instant-quote rounding so the
// pre-filled price lands on the same clean number the customer was shown.
const roundTo5 = (n) => Math.round((Number(n) || 0) / 5) * 5
// Flat 30-day validity policy: a new quote's "Valid Until" defaults to 30 days
// out (still editable) so it's never empty and matches the backend default.
const defaultValidUntil = () => {
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return d.toISOString().slice(0, 10)
}

// Names that are really phone numbers / intake placeholders — never greet
// with these ("Hello +12074329492" shipped to a real customer on June 11).
const PLACEHOLDER_RE = /^(unknown|brightbase webhook test|webhook test|test client|n\/a|\+?[\d\s().-]+)$/i
const isPlaceholderName = (n) => !n || !n.trim() || PLACEHOLDER_RE.test(n.trim())

// Quote templates (and their prices) live ONLY in the backend
// (/api/settings/quote-templates), which seeds a default set when the admin
// hasn't customized any. We deliberately keep NO hardcoded copy here — a second
// price list in the frontend is a rate card that silently drifts from the
// backend's. Templates load on mount; until then (or if the fetch fails) the
// picker just offers "Custom (build from scratch)".

function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-panel border border-hairline text-ink text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}

export default function Quoting() {
  const navigate = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState('leads')
  const [quotes, setQuotes] = useState([])
  const [followUps, setFollowUps] = useState([])
  const [nudging, setNudging] = useState(null)
  const [intakes, setIntakes] = useState([])
  const [clients, setClients] = useState([])
  const [quoteTemplates, setQuoteTemplates] = useState([])
  // Gate the template editor until the initial GET settles. Without this, an
  // admin could open the editor while templates are still [] (loading), then
  // Save — overwriting all stored templates with an empty list.
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  // Full customer-facing identity (Settings → General) — drives the REAL
  // public-page preview, SMS copy, and send-panel subject prefill.
  const [company, setCompany] = useState({ company_name: 'Maine Cleaning Co' })
  const companyName = company.company_name || 'Maine Cleaning Co'
  const [panel, setPanel] = useState(null) // 'quote' | 'send' | 'templates' | null
  const [selected, setSelected] = useState(null)
  const [selectedIntake, setSelectedIntake] = useState(null)
  const [quoteSearch, setQuoteSearch] = useState('')
  const [quoteStatusFilter, setQuoteStatusFilter] = useState('')
  const [form, setForm] = useState({
    client_id: '', intake_id: null, title: '', customer_message: '',
    address: '', service_type: 'residential',
    items: [{ ...EMPTY_ITEM }], tax_rate: 0, notes: '', internal_notes: '', valid_until: defaultValidUntil(),
    custom_fields: {}
  })
  const [sendForm, setSendForm] = useState({ channel: 'email', email: '', phone: '', custom_message: '', subject: '', greeting: '', copy_to: '' })
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [converting, setConverting] = useState(null)
  const [toast, setToast] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  // Live customer-facing preview alongside the editor (§7.2 #4 quote reader).
  const [previewMode, setPreviewMode] = useState(false)
  // The fast path is client → line items → save. Template picker and the
  // scope/internal/message text areas live behind this toggle so the form
  // opens short.
  const [showQuoteAdvanced, setShowQuoteAdvanced] = useState(false)
  const [copiedQuoteId, setCopiedQuoteId] = useState(null)
  const [archivedQuotes, setArchivedQuotes] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Template manager (create/edit/delete reusable quote templates). Saving needs
  // admin/manager (PUT is role-gated), so only show the editor to those roles.
  const [editTemplates, setEditTemplates] = useState([])
  const [savingTemplates, setSavingTemplates] = useState(false)
  // Quote mutations (create/edit/send/accept/decline/convert) are admin/manager
  // only on the backend — gate the controls so viewers get a read-only funnel
  // instead of buttons that 403. Same check drives the template editor.
  const canEdit = (() => {
    try { return ['admin', 'manager'].includes(JSON.parse(localStorage.getItem('brightbase_user') || '{}').role) }
    catch { return false }
  })()
  const canManageTemplates = canEdit
  // Inline "new client" quick-add from the quote form.
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  // Selecting a client fills the quote address from the client's address when
  // it's still blank (smart default; never clobbers typed input).
  const selectClient = (idStr) => {
    const c = clients.find(c => String(c.id) === String(idStr))
    setForm(f => {
      const next = { ...f, client_id: idStr }
      if (c && !f.address) {
        // "123 Main St, Portland, ME 04101" — keep the ZIP so the quote (and any
        // job converted from it) has the complete service address.
        const cityStateZip = [[c.city, c.state].filter(Boolean).join(', '), c.zip_code]
          .filter(Boolean).join(' ')
        next.address = [c.address, cityStateZip].filter(Boolean).join(', ')
      }
      return next
    })
  }

  // Create a client without leaving the quote form, then select it.
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

  // ── Template manager helpers ─────────────────────────────────────────────
  const tplSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `tpl_${Date.now()}`
  const addTemplate = () => setEditTemplates(ts => [...ts, {
    id: `tpl_${Date.now()}`, label: '', service_type: 'residential',
    items: [{ name: '', description: '', qty: 1, unit_price: 0 }],
  }])
  const updateTemplate = (i, patch) => setEditTemplates(ts => ts.map((t, idx) => idx === i ? { ...t, ...patch } : t))
  const removeTemplate = (i) => setEditTemplates(ts => ts.filter((_, idx) => idx !== i))
  const updateTplItem = (ti, ii, patch) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: t.items.map((it, j) => j === ii ? { ...it, ...patch } : it) }))
  const addTplItem = (ti) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: [...t.items, { name: '', description: '', qty: 1, unit_price: 0 }] }))
  const removeTplItem = (ti, ii) => setEditTemplates(ts => ts.map((t, idx) =>
    idx !== ti ? t : { ...t, items: t.items.filter((_, j) => j !== ii) }))

  const saveTemplates = async () => {
    // Never save before the initial load settled — a PUT here would clobber the
    // stored templates with whatever the editor was seeded from (possibly []).
    if (!templatesLoaded) { showToast('Templates are still loading — try again'); return }
    // Normalize + validate: each template needs a label and ≥1 named item.
    const cleaned = editTemplates.map(t => ({
      id: t.id || tplSlug(t.label),
      label: (t.label || '').trim(),
      title: (t.title || '').trim(),
      customer_message: (t.customer_message || '').trim(),
      service_type: t.service_type || 'residential',
      items: (t.items || []).filter(i => (i.name || '').trim()).map(i => ({
        name: i.name.trim(), description: i.description || '',
        qty: Number(i.qty) || 1, unit_price: Number(i.unit_price) || 0,
      })),
    }))
    for (const t of cleaned) {
      if (!t.label) { showToast('Every template needs a name'); return }
      if (!t.items.length) { showToast(`"${t.label}" needs at least one line item`); return }
    }
    setSavingTemplates(true)
    try {
      const res = await put('/api/settings/quote-templates', { templates: cleaned })
      setQuoteTemplates(res?.templates || cleaned)
      setPanel(null)
      showToast('Templates saved ✓')
    } catch (e) { showToast(e.message || 'Could not save templates') }
    setSavingTemplates(false)
  }

  // Honor ?tab=quotes|leads|follow-ups (e.g. from the dashboard's tiles).
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab')
    if (t === 'quotes' || t === 'leads' || t === 'follow-ups') setTab(t)
    else if (t === 'archived') { setTab('archived'); loadArchived() }
  }, [location.search])

  // Guard (June 10 P1): one malformed row — legacy JSON shapes where items is
  // a dict/string, or a non-string status — must never crash or wedge the page.
  // Coerce the fields the page iterates/renders before they reach state.
  const safeQuote = (q) => ({
    ...q,
    items: Array.isArray(q?.items) ? q.items : [],
    status: typeof q?.status === 'string' ? q.status : 'draft',
  })

  const loadQuotes = () => get('/api/quotes').then(d => setQuotes(Array.isArray(d) ? d.map(safeQuote) : [])).catch(err => console.error("[Quoting]", err))
  const loadIntakes = () => get('/api/intake').then(d => setIntakes(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
  // Quotes the customer is sitting on (sent-but-unopened / opened-but-no-reply).
  const loadFollowUps = () => get('/api/quotes/follow-ups').then(d => setFollowUps(Array.isArray(d) ? d.map(safeQuote) : [])).catch(err => console.error("[Quoting]", err))

  useEffect(() => {
    loadQuotes()
    loadIntakes()
    loadFollowUps()
    get('/api/clients').then(d => setClients(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
    get('/api/settings/quote-templates').then(d => {
      // Treat any array as authoritative — including [] — so deleting every
      // template sticks instead of the hardcoded defaults reappearing on reload.
      if (Array.isArray(d?.templates)) setQuoteTemplates(d.templates)
    }).catch(() => {}).finally(() => setTemplatesLoaded(true))
    // Customer-facing identity for previews/SMS/subjects. /general is the
    // canonical source; fall back to the legacy settings dump for viewers.
    get('/api/settings/general')
      .then(d => setCompany(c => ({ ...c, ...Object.fromEntries(Object.entries(d || {}).filter(([, v]) => v != null)) })))
      .catch(() => get('/api/settings')
        .then(d => { if (d?.company_name) setCompany(c => ({ ...c, company_name: d.company_name })) })
        .catch(() => {}))
  }, [])

  useEffect(() => {
    if (location.state?.quoteId) {
      get(`/api/quotes/${location.state.quoteId}`).then(q => {
        openQuoteForm(safeQuote(q))
        setTab('quotes')
      }).catch(err => console.error("[Quoting]", err))
    }
  }, [location.state?.quoteId])

  // Open the new-quote form pre-filled with a client (used by ClientProfile's "New Quote" button)
  useEffect(() => {
    if (location.state?.openNew && location.state?.clientId) {
      setSelected(null)
      setSelectedIntake(null)
      setForm(f => ({
        ...f,
        client_id: location.state.clientId,
        intake_id: null,
        title: '',
        customer_message: '',
        internal_notes: '',
        items: [{ ...EMPTY_ITEM }],
        custom_fields: {},
      }))
      setPanel('quote')
      setTab('quotes')
    }
  }, [location.state?.openNew, location.state?.clientId])

  // Open the new-quote form pre-filled from a LeadIntake (Requests page → "Create Quote")
  useEffect(() => {
    const intake = location.state?.openNewFromIntake
    if (intake) {
      openQuoteForm(null, intake)
      setTab('quotes')
    }
    // We deliberately only run when the intake id changes; openQuoteForm is
    // stable within a render and React-Router doesn't change location.state
    // reference unless the navigation actually fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.openNewFromIntake?.id])

  const clientFor = (id) => clients.find(c => c.id === id)
  const clientName = (id) => clientFor(id)?.name || `Client #${id}`

  const subtotal = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
  const taxAmt = (items, rate) => subtotal(items) * (parseFloat(rate) || 0) / 100
  const total = (items, rate) => subtotal(items) + taxAmt(items, rate)

  const updateItem = (i, key, val) => setForm(f => {
    const items = [...f.items]
    items[i] = { ...items[i], [key]: val }
    return { ...f, items }
  })

  const openQuoteForm = (q = null, intake = null) => {
    setSelected(q)
    setSelectedIntake(intake)
    // Auto-expand the optional-copy section when there's already something in it
    // (editing an existing quote, or a lead whose message seeds internal notes).
    // Expand the scope/notes section when there's already content — editing an
    // existing quote, or a new quote from a request (we pre-fill scope + notes).
    setShowQuoteAdvanced(Boolean(q?.notes || q?.internal_notes || q?.customer_message || intake))
    if (q) {
      setForm({ client_id: q.client_id, intake_id: q.intake_id,
        title: q.title || '', customer_message: q.customer_message || '',
        address: q.address || '',
        service_type: q.service_type || 'residential', items: q.items?.length ? q.items : [{ ...EMPTY_ITEM }],
        tax_rate: q.tax_rate, notes: q.notes || '', internal_notes: q.internal_notes || '',
        valid_until: q.valid_until || '', custom_fields: q.custom_fields || {} })
    } else if (intake) {
      // Seed the price from the lead's website "instant quote" (midpoint of the
      // estimate range, rounded to $5 like the site) so the quote starts from
      // the SAME number the customer was shown.
      const mid = (intake.estimate_min != null && intake.estimate_max != null)
        ? roundTo5((intake.estimate_min + intake.estimate_max) / 2)
        : roundTo5(intake.estimate_max ?? intake.estimate_min ?? 0)
      const svcType = intake.service_type || 'residential'
      // Surface the customer's structured details on the line item so the
      // operator confirms against real data instead of re-deriving it.
      const details = [
        intake.square_footage && `${intake.square_footage.toLocaleString()} sqft`,
        intake.bedrooms && `${intake.bedrooms} bd`,
        intake.bathrooms && `${intake.bathrooms} ba`,
        freqLabel(intake.frequency) || intake.frequency,
      ].filter(Boolean).join(' · ')
      const lineDesc = [mid ? 'From website instant quote' : '', details].filter(Boolean).join(' — ')
      // Friendly line name: "Biweekly residential cleaning".
      const freq = freqLabel(intake.frequency)
      const lineName = [freq, serviceLabel(svcType).replace(/^STR \/ Vacation rental cleaning$/, 'STR / vacation rental clean')]
        .filter(Boolean).join(' ')
      setForm({
        client_id: intake.client_id || '', intake_id: intake.id,
        // Auto-fill a sensible title and customer-facing scope so the quote is
        // mostly built — the admin just reviews, tweaks, and sends.
        title: titleFromIntake(intake), customer_message: '',
        address: [intake.address, intake.city, intake.state].filter(Boolean).join(', '),
        service_type: svcType,
        items: [{
          ...EMPTY_ITEM,
          name: lineName || serviceLabel(svcType),
          unit_price: mid || 0,
          description: lineDesc,
        }],
        tax_rate: 0,
        // Admin-configured scope (Settings → Service Descriptions) wins; fall
        // back to the built-in default for the service type.
        notes: (company[`service_scope_${svcType}`] || '').trim() || SERVICE_SCOPE[svcType] || '',
        // The lead's website message is operator context — it leaked onto a
        // live public quote page on June 11. It belongs in internal notes.
        internal_notes: intake.message || '',
        valid_until: defaultValidUntil(),
        custom_fields: {}
      })
      // Best-effort: when property-data enrichment is on, fill missing specs
      // (sqft/beds/baths/year) into the line description by address.
      const fullAddr = [intake.address, intake.city, intake.state].filter(Boolean).join(', ')
      if (fullAddr) {
        get(`/api/quotes/property-lookup?address=${encodeURIComponent(fullAddr)}`)
          .then(r => {
            const s = r?.specs
            if (!s) return
            setForm(f => {
              const items = [...f.items]
              const desc = items[0]?.description || ''
              // Merge each spec individually — only add the ones the lead didn't
              // already provide, instead of skipping the whole lookup when any
              // one spec is already present.
              const extra = [
                s.square_footage && !/sqft/i.test(desc) && `${s.square_footage.toLocaleString()} sqft`,
                s.bedrooms != null && !/\bbd\b|bedroom/i.test(desc) && `${s.bedrooms} bd`,
                s.bathrooms != null && !/\bba\b|bathroom/i.test(desc) && `${s.bathrooms} ba`,
                s.year_built && !/built/i.test(desc) && `built ${s.year_built}`,
              ].filter(Boolean).join(' · ')
              if (!extra || !items[0]) return f
              items[0] = { ...items[0], description: [desc, extra].filter(Boolean).join(' — ') }
              return { ...f, items }
            })
          })
          .catch(() => {})
      }
    } else {
      setForm({ client_id: '', intake_id: null, title: '', customer_message: '',
        address: '', service_type: 'residential',
        items: [{ ...EMPTY_ITEM }], tax_rate: 0, notes: '', internal_notes: '', valid_until: defaultValidUntil(), custom_fields: {} })
    }
    setPanel('quote')
  }

  const openSendPanel = (q) => {
    const client = clientFor(q.client_id)
    // Prefer the linked intake's contact info — when the lead auto-matched to
    // a placeholder client (e.g. "BrightBase Webhook Test"), the client.email
    // is the wrong address. The intake has the real lead's email.
    const intake = q.intake_id ? intakes.find(i => i.id === q.intake_id) : null
    const preferEmail = intake?.email || client?.email || ''
    const preferPhone = intake?.phone || client?.phone || ''
    const clientName = (intake?.name || client?.name || '').trim()
    setSendForm({
      channel: preferEmail ? 'email' : 'sms',
      email: preferEmail,
      phone: preferPhone,
      custom_message: '',
      subject: `Your Quote ${q.quote_number} from ${companyName}`,
      // First name only — friendlier and matches the email/SMS greeting.
      greeting: isPlaceholderName(clientName) ? '' : clientName.split(/\s+/)[0],
      // Owner copy: default to the business email so you always get a copy of
      // what the customer received. Editable/clearable below.
      copy_to: company.company_email || '',
    })
    setSelected(q)
    setPanel('send')
  }

  const save = async () => {
    if (!form.client_id) { showToast('Please select a client first'); return }
    if (!form.items.length || form.items.every(i => !i.name || !i.name.trim())) { showToast('Add at least one line item with a name'); return }
    setSaving(true)
    try {
      const body = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
      if (selected) {
        await patch(`/api/quotes/${selected.id}`, body)
      } else {
        await post('/api/quotes', body)
      }
      await loadQuotes(); await loadIntakes()
      setPanel(null)
      showToast(selected ? 'Quote updated' : 'Quote created')
    } catch (e) { showToast(e.message || 'Error saving quote') }
    setSaving(false)
  }

  const sendQuote = async () => {
    if (!selected) return
    setSending(true)
    try {
      await post(`/api/quotes/${selected.id}/generate-token`, {})
      // A blank copy field means "use the default owner copy" — send null so the
      // backend falls back to the company email (which itself falls back to the
      // from/SMTP address). An empty string would be read as "skip the copy",
      // silently dropping the owner copy on a setup with no Company Email set.
      const payload = { ...sendForm, copy_to: (sendForm.copy_to || '').trim() || null }
      const data = await post(`/api/quotes/${selected.id}/send`, payload)
      if (data.delivered) {
        const sent = Object.entries(data.results || {})
          .filter(([, v]) => v === 'sent').map(([k]) => k)
        const failed = Object.entries(data.results || {})
          .filter(([, v]) => v !== 'sent')
        if (failed.length) {
          // Partial send: one channel went out but another FAILED. Surface it
          // loudly with the reason — a silent "sent ✓" hid email failures so
          // the owner thought a both-channel send fully delivered when it didn't.
          const failNames = failed.map(([k, v]) => `${k} ${v === 'failed' ? 'failed' : `(${v})`}`).join(', ')
          const reason = (data.errors || []).join('; ')
          showToast(`Sent via ${sent.join(' & ') || 'none'}, but ${failNames}${reason ? ` — ${reason}` : ''}`)
        } else {
          showToast(`Quote sent via ${sent.join(' & ')} ✓`)
        }
      } else {
        // Nothing went out (e.g. email server hiccup), but the link is ready —
        // copy it so the owner can still share the quote manually.
        const reason = (data.errors || []).join('; ') || 'delivery failed'
        if (data.quote_link && navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(data.quote_link) } catch {}
          showToast(`Couldn't send (${reason}) — link copied to share manually`)
        } else {
          showToast(`Couldn't send: ${reason}`)
        }
      }
      await loadQuotes()
      setPanel(null)
    } catch (e) { showToast(e.message || 'Error sending quote') }
    setSending(false)
  }

  // One-click follow-up nudge: re-send the quote by email to the address on
  // file. The backend records it as a follow-up (keeps the original sent/viewed
  // state intact) — nothing is auto-sent; this only fires when the owner clicks.
  const sendFollowUp = async (q) => {
    setNudging(q.id)
    try {
      await post(`/api/quotes/${q.id}/generate-token`, {})
      const data = await post(`/api/quotes/${q.id}/send`, { channel: 'email' })
      const channels = Object.entries(data.results || {}).filter(([, v]) => v === 'sent').map(([k]) => k)
      showToast(`Follow-up sent via ${channels.join(' & ') || 'email'} ✓`)
      await Promise.all([loadQuotes(), loadFollowUps()])
    } catch (e) { showToast(e.message || 'Could not send follow-up') }
    setNudging(null)
  }

  const updateStatus = async (id, status) => {
    await patch(`/api/quotes/${id}`, { status })
    loadQuotes()
    loadFollowUps()
  }

  const markIntakeReviewed = async (id) => {
    await patch(`/api/intake/${id}`, { status: 'reviewed' })
    loadIntakes()
  }

  const updateLeadStatus = async (id, status) => {
    await patch(`/api/intake/${id}`, { status })
    loadIntakes()
  }

  const convertToJob = async (quoteId) => {
    setConverting(quoteId)
    try {
      const job = await post(`/api/quotes/${quoteId}/convert-to-job`)
      showToast('Job created — set the date in Scheduling')
      navigate(`/scheduling`)
    } catch (e) { showToast(e.message || 'Error converting to job') }
    setConverting(null)
  }

  const archiveQuote = async (quote) => {
    if (!window.confirm(`Archive quote ${quote.quote_number || quote.id}? It will be hidden from this list.`)) return
    try {
      await del(`/api/quotes/${quote.id}`)
      if (selected?.id === quote.id) { setSelected(null); setPanel(null) }
      await loadQuotes()
      showToast('Quote archived')
    } catch (e) { showToast(e.message || 'Could not archive quote') }
  }

  // Permanent (hard) delete is admin-only and lives in the Archived view.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()

  const loadArchived = () => get('/api/quotes?status=archived')
    .then(d => setArchivedQuotes(Array.isArray(d) ? d.map(safeQuote) : []))
    .catch(err => console.error("[Quoting]", err))

  // --- Bulk selection (quotes + archived tabs) ------------------------------
  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const clearSelection = () => setSelectedIds(new Set())

  const bulkArchive = async () => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!window.confirm(`Archive ${ids.length} quote${ids.length === 1 ? '' : 's'}? They'll be hidden from this list.`)) return
    let failed = 0
    for (const id of ids) { try { await del(`/api/quotes/${id}`) } catch { failed++ } }
    clearSelection(); await loadQuotes()
    showToast(failed
      ? `Archived ${ids.length - failed} of ${ids.length} · ${failed} couldn't be archived (scheduled into a job?)`
      : `Archived ${ids.length} quote${ids.length === 1 ? '' : 's'}`)
  }

  const bulkDeletePermanent = async () => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!window.confirm(`Permanently delete ${ids.length} quote${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return
    let failed = 0
    for (const id of ids) { try { await del(`/api/quotes/${id}/permanent`) } catch { failed++ } }
    clearSelection(); await loadArchived()
    showToast(failed
      ? `Deleted ${ids.length - failed} of ${ids.length} · ${failed} failed`
      : `Deleted ${ids.length} quote${ids.length === 1 ? '' : 's'}`)
  }

  const deletePermanent = async (q) => {
    if (!window.confirm(`Permanently delete quote ${q.quote_number || q.id}? This cannot be undone.`)) return
    try { await del(`/api/quotes/${q.id}/permanent`); await loadArchived(); showToast('Quote deleted permanently') }
    catch (e) { showToast(e.message || 'Could not delete quote') }
  }

  const switchTab = (t) => { clearSelection(); setTab(t); if (t === 'archived') loadArchived() }

  // Onboard an accepted quote: open the job modal (recurring by default,
  // pre-filled from the quote) to set up the repeating schedule + first job on
  // Google Calendar, then mark the quote converted.
  const [scheduleQuote, setScheduleQuote] = useState(null)
  const quoteJobType = (svc) => (svc === 'str' ? 'str_turnover' : (svc === 'commercial' ? 'commercial' : 'residential'))
  const finishOnboard = async () => {
    if (!scheduleQuote) return
    try { await patch(`/api/quotes/${scheduleQuote.id}`, { status: 'converted' }) } catch { /* non-fatal */ }
    setScheduleQuote(null)
    await loadQuotes()
    showToast('Client onboarded — schedule created ✓')
  }

  const copyPublicLink = async (quote) => {
    if (!quote.public_token) {
      try {
        const token = await post(`/api/quotes/${quote.id}/generate-token`, {})
        quote = { ...quote, public_token: token.public_token }
      } catch (e) {
        showToast('Error generating link')
        return
      }
    }
    const appUrl = window.location.origin
    const link = `${appUrl}/quote/${quote.public_token}`
    await navigator.clipboard.writeText(link)
    setCopiedQuoteId(quote.id)
    showToast('Link copied!')
    setTimeout(() => setCopiedQuoteId(null), 2000)
  }

  // Preview text for send panel
  const previewSMS = () => {
    if (!selected) return ''
    const q = selected
    const st = (q.service_type || 'residential').charAt(0).toUpperCase() + (q.service_type || 'residential').slice(1)
    return `${companyName} — Quote ${q.quote_number || `QT-${q.id}`}\n${st} clean${q.address ? ` at ${q.address}` : ''}\nTotal: $${parseFloat(q.total || 0).toFixed(2)}${q.valid_until ? `\nValid until: ${q.valid_until}` : ''}\n\nReply YES to accept or ask any questions.`
  }

  const newLeads = intakes.filter(i => i.status === 'new').length

  // Quotes-tab filtering, persisted by saved views (entityType="quote").
  const quoteViewConfig = { search: quoteSearch, status: quoteStatusFilter }
  const applyQuoteView = (cfg) => { setQuoteSearch(cfg.search ?? ''); setQuoteStatusFilter(cfg.status ?? '') }
  const visibleQuotes = quotes.filter(q => {
    if (quoteStatusFilter && q.status !== quoteStatusFilter) return false
    const term = quoteSearch.trim().toLowerCase()
    if (!term) return true
    return [clientName(q.client_id), q.quote_number, q.address].some(v => (v || '').toLowerCase().includes(term))
  })

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0 overflow-hidden">

        {/* Tabs + action */}
        <div className="flex justify-between items-center mb-5 shrink-0">
          <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-1">
            <button onClick={() => switchTab('leads')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'leads' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
              Leads
              {newLeads > 0 && <span className="bg-yellow-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{newLeads}</span>}
            </button>
            <button onClick={() => switchTab('quotes')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'quotes' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
              Quotes
            </button>
            <button onClick={() => switchTab('follow-ups')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'follow-ups' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
              Follow-ups
              {followUps.length > 0 && <span className="bg-amber-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{followUps.length}</span>}
            </button>
            <button onClick={() => switchTab('archived')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'archived' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
              Archived
            </button>
          </div>
          <div className="flex items-center gap-2">
            {canManageTemplates && (
              <button
                disabled={!templatesLoaded}
                title={templatesLoaded ? undefined : 'Loading templates…'}
                onClick={() => { setEditTemplates(quoteTemplates.map(t => ({ ...t, items: (t.items || []).map(i => ({ ...i })) }))); setPanel('templates') }}
                className="flex items-center gap-1.5 bg-bg-2 hover:bg-hairline text-ink-2 border border-hairline px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <FileText className="w-4 h-4" /> <span className="hidden sm:inline">Templates</span>
              </button>
            )}
            {canEdit && (
              <button onClick={() => { openQuoteForm(); setTab('quotes') }}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> New Quote
              </button>
            )}
          </div>
        </div>

        {/* Leads tab */}
        {tab === 'leads' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {intakes.length === 0 && (
              <div className="text-center py-16 text-ink-3">
                <p className="text-sm">No leads yet</p>
                <p className="text-xs mt-1 text-ink-3">Submissions from maineclean.co will appear here</p>
              </div>
            )}
            {intakes.length > 0 && (
            <div className="border border-hairline rounded-lg bg-panel divide-y divide-hairline overflow-hidden">
            {intakes.map(intake => (
              <div key={intake.id} className="p-3 hover:bg-bg-2/40 transition-colors">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium text-ink">{intake.name}</span>
                      <span onClick={e => e.stopPropagation()}>
                        <InlineSelect value={intake.status} options={LEAD_STATUS_OPTIONS}
                          onSelect={(s) => updateLeadStatus(intake.id, s)}
                          disabled={!canEdit || intake.status === 'converted'} />
                      </span>
                      <span className="text-xs text-ink-3 capitalize bg-bg-2 px-2 py-0.5 rounded-full">{intake.service_type}</span>
                    </div>
                    {/* Structured request chips — the data the customer entered on
                        the website (sqft/beds/baths/frequency/estimate), so the
                        operator reads it at a glance instead of from the message blob. */}
                    {(intake.square_footage || intake.bedrooms || intake.bathrooms || intake.frequency
                      || intake.estimate_min != null) && (
                      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                        {intake.square_footage ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.square_footage.toLocaleString()} sqft</span> : null}
                        {intake.bedrooms ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.bedrooms} bd</span> : null}
                        {intake.bathrooms ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2">{intake.bathrooms} ba</span> : null}
                        {intake.frequency ? <span className="text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-2 capitalize">{intake.frequency}</span> : null}
                        {(intake.estimate_min != null && intake.estimate_max != null) ? (
                          <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium">
                            ${Math.round(intake.estimate_min)}–${Math.round(intake.estimate_max)}
                          </span>
                        ) : null}
                      </div>
                    )}
                    <div className="text-xs text-ink-3 space-y-0.5">
                      {(intake.phone || intake.email) && <div>{[intake.phone, intake.email].filter(Boolean).join(' · ')}</div>}
                      {intake.address && <div>{[intake.address, intake.city, intake.state].filter(Boolean).join(', ')}</div>}
                      {intake.preferred_date && <div>Preferred: {formatDate(intake.preferred_date)}</div>}
                      {intake.message && <div className="text-ink-3 italic mt-1 line-clamp-2">"{intake.message}"</div>}
                    </div>
                    <div className="text-xs text-ink-3 mt-1.5">
                      {new Date(intake.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {canEdit && intake.status === 'new' && (
                      <button onClick={() => markIntakeReviewed(intake.id)}
                        className="text-xs px-3 py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 rounded-lg transition-colors border border-hairline">
                        Mark Reviewed
                      </button>
                    )}
                    {canEdit && intake.status !== 'converted' && (
                      <button onClick={() => { openQuoteForm(null, intake); setTab('quotes') }}
                        className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Create Quote
                      </button>
                    )}
                    {intake.client_id && (
                      <button onClick={() => navigate(`/clients/${intake.client_id}`)}
                        className="text-xs px-3 py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-3 rounded-lg transition-colors">
                        View Client
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            </div>
            )}
          </div>
        )}

        {/* Quotes tab */}
        {tab === 'quotes' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={quoteSearch} onChange={e => setQuoteSearch(e.target.value)} placeholder="Search quotes…"
                  className="w-full bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400" />
              </div>
              <select value={quoteStatusFilter} onChange={e => setQuoteStatusFilter(e.target.value)}
                className="bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-[12px] text-ink-2 focus:outline-none focus:border-blue-400">
                <option value="">All statuses</option>
                {['draft', 'sent', 'viewed', 'accepted', 'declined', 'converted'].map(s =>
                  <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
              </select>
              <SavedViewsBar entityType="quote" currentConfig={quoteViewConfig} onApply={applyQuoteView} defaultLabel="All quotes" />
            </div>
            {canEdit && selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-blue-600/10 border border-blue-600/30 rounded-xl px-4 py-2.5">
                <span className="text-sm text-ink font-medium">{selectedIds.size} selected</span>
                <div className="flex items-center gap-2">
                  <button onClick={bulkArchive}
                    className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-panel border border-hairline text-ink-2 hover:text-red-500 hover:bg-red-50 transition-colors">
                    <Trash2 className="w-4 h-4" /> Archive {selectedIds.size}
                  </button>
                  <button onClick={clearSelection} className="text-sm px-2 py-1.5 text-ink-3 hover:text-ink">Clear</button>
                </div>
              </div>
            )}
            {quotes.length === 0 && <div className="text-center py-16 text-ink-3 text-sm">No quotes yet</div>}
            {quotes.length > 0 && visibleQuotes.length === 0 && (
              <div className="text-center py-16 text-ink-3 text-sm">No quotes match your filters</div>
            )}
            {visibleQuotes.length > 0 && (
            <div className="border border-hairline rounded-lg bg-panel divide-y divide-hairline overflow-hidden">
            {visibleQuotes.map(q => (
              <div key={q.id} className="p-3 hover:bg-bg-2/40 transition-colors">
                <div className="flex items-center gap-3">
                  {canEdit && (
                    <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => toggleSelect(q.id)}
                      className="w-4 h-4 shrink-0 rounded border-hairline accent-blue-600 cursor-pointer"
                      title="Select for bulk action" />
                  )}
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{clientName(q.client_id)}</span>
                      <span className="text-xs text-ink-3">{q.quote_number}</span>
                      {canEdit && ['draft', 'sent', 'viewed', 'accepted', 'declined'].includes(q.status) ? (
                        <span onClick={e => e.stopPropagation()}>
                          <InlineSelect value={q.status} options={QUOTE_STATUS_OPTIONS}
                            onSelect={(s) => updateStatus(q.id, s)} />
                        </span>
                      ) : (
                        <span className={`text-xs px-2.5 py-0.5 rounded-full border capitalize ${QUOTE_STATUS_COLORS[q.status] || QUOTE_STATUS_COLORS.draft}`}>{(q.status || '').replace(/_/g, ' ')}</span>
                      )}
                      {q.status === 'changes_requested' && <span className="w-2 h-2 rounded-full bg-amber-500" title="Customer requested changes" />}
                      {q.last_send_error && ['draft', 'sent', 'viewed'].includes(q.status) && (
                        <span className="text-xs px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200"
                          title={q.last_send_error}>
                          send failed
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address, `${q.items?.length || 0} items`, new Date(q.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
                    </div>
                    {QUOTE_NEXT_STEP[q.status] && (
                      <div className={`text-[11px] font-medium mt-1 ${QUOTE_NEXT_STEP[q.status].cls}`}>
                        {QUOTE_NEXT_STEP[q.status].text}
                      </div>
                    )}
                  </div>
                  <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => navigate(`/quotes/${q.id}`)}
                      className="text-xs px-2.5 py-1.5 bg-bg-2 text-ink-2 hover:bg-bg-3 rounded-lg transition-colors"
                      title="Open full page">
                      Open
                    </button>
                    {canEdit && (q.status === 'draft' || q.status === 'sent') && (
                      <button onClick={() => openSendPanel(q)}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors">
                        <Send className="w-3 h-3" /> Send
                      </button>
                    )}
                    {canEdit && q.status === 'sent' && (
                      <button onClick={() => copyPublicLink(q)}
                        className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${copiedQuoteId === q.id ? 'bg-green-600/30 text-green-400' : 'bg-purple-600/20 text-purple-400 hover:bg-purple-600/30'}`}>
                        {copiedQuoteId === q.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedQuoteId === q.id ? 'Copied' : 'Copy Link'}
                      </button>
                    )}
                    {/* Accept / Decline removed — the inline status dropdown next
                        to the client name already sets those states (most quotes
                        are accepted by the customer via their link anyway). */}
                    {canEdit && q.status === 'accepted' && (
                      <button onClick={() => setScheduleQuote(q)}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
                        <Calendar className="w-3 h-3" />
                        Set up schedule
                      </button>
                    )}
                    {q.status === 'converted' && (
                      <span className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-green-50 text-green-500 rounded-lg"
                        title="This quote has been scheduled">
                        <Calendar className="w-3 h-3" />
                        Scheduled ✓
                      </span>
                    )}
                    {canEdit && q.status !== 'converted' && (
                      <button onClick={() => archiveQuote(q)}
                        title="Archive (hide) this quote"
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 text-ink-3 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-3 h-3" />
                        Archive
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            </div>
            )}
          </div>
        )}

        {/* Needs follow-up tab — quotes the customer is sitting on */}
        {tab === 'follow-ups' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {followUps.length === 0 && (
              <div className="text-center py-16 text-ink-3">
                <p className="text-sm">No quotes need a follow-up</p>
                <p className="text-xs mt-1 text-ink-3">Sent quotes the customer hasn't opened (48h+) or opened but hasn't answered (24h+) show up here.</p>
              </div>
            )}
            {followUps.map(q => {
              const h = q.hours_waiting || 0
              const waited = h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`
              const reasonLabel = q.follow_up_reason === 'viewed_not_accepted' ? 'Opened, no reply' : 'Not opened yet'
              const reasonTone = q.follow_up_reason === 'viewed_not_accepted'
                ? 'bg-purple-50 text-purple-500 border-purple-200' : 'bg-amber-50 text-amber-600 border-amber-200'
              return (
                <div key={q.id} className="bg-panel border border-hairline rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{clientName(q.client_id)}</span>
                        <span className="text-xs text-ink-3">{q.quote_number}</span>
                        <span className={`text-xs px-2.5 py-0.5 rounded-full border ${reasonTone}`}>{reasonLabel}</span>
                        <span className="text-xs text-ink-3">waiting {waited}</span>
                        {q.follow_up_sent_at && <span className="text-xs text-ink-3">· nudged before</span>}
                      </div>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {[q.address, `${q.items?.length || 0} items`, q.sent_at && `sent ${new Date(q.sent_at).toLocaleDateString()}`].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
                    {canEdit && (
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => sendFollowUp(q)} disabled={nudging === q.id}
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors">
                          <Send className="w-3 h-3" /> {nudging === q.id ? 'Sending…' : 'Send follow-up'}
                        </button>
                        <button onClick={() => openSendPanel(q)}
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-bg-2 hover:bg-hairline text-ink-2 border border-hairline rounded-lg transition-colors">
                          Options
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Archived tab — soft-deleted quotes, viewable + permanently deletable */}
        {tab === 'archived' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {isAdmin && selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-red-600/10 border border-red-600/30 rounded-xl px-4 py-2.5">
                <span className="text-sm text-ink font-medium">{selectedIds.size} selected</span>
                <div className="flex items-center gap-2">
                  <button onClick={bulkDeletePermanent}
                    className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors">
                    <Trash2 className="w-4 h-4" /> Delete {selectedIds.size} permanently
                  </button>
                  <button onClick={clearSelection} className="text-sm px-2 py-1.5 text-ink-3 hover:text-ink">Clear</button>
                </div>
              </div>
            )}
            {archivedQuotes.length === 0 && (
              <div className="text-center py-16 text-ink-3 text-sm">No archived quotes</div>
            )}
            {archivedQuotes.map(q => (
              <div key={q.id} className="bg-panel border border-hairline rounded-xl p-4">
                <div className="flex items-center gap-3">
                  {isAdmin && (
                    <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => toggleSelect(q.id)}
                      className="w-4 h-4 shrink-0 rounded border-hairline accent-red-600 cursor-pointer"
                      title="Select for permanent delete" />
                  )}
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{clientName(q.client_id)}</span>
                      <span className="text-xs text-ink-3">{q.quote_number}</span>
                      <span className="text-xs px-2.5 py-0.5 rounded-full border bg-bg-2 text-ink-3 border-hairline">archived</span>
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address,
                        q.archived_at && `archived ${new Date(q.archived_at).toLocaleDateString()}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
                  {isAdmin && (
                    <button onClick={() => deletePermanent(q)}
                      title="Delete permanently"
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!isAdmin && archivedQuotes.length > 0 && (
              <p className="text-xs text-ink-3 text-center pt-2">Permanent deletion is admin-only.</p>
            )}
          </div>
        )}
      </div>

      {/* Quote edit panel — full-screen sheet on mobile (sits above the z-30
          BottomNav so the Save button is reachable), side panel on desktop. */}
      {panel === 'quote' && (
        <div className={`fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:border-l sm:border-hairline sm:shrink-0 ${previewMode ? 'sm:w-[500px] 2xl:w-[900px]' : 'sm:w-[500px]'}`}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
            <div>
              <h2 className="font-semibold text-ink">{selected ? `Edit ${selected.quote_number}` : 'New Quote'}</h2>
              {selectedIntake && <p className="text-xs text-ink-3 mt-0.5">From: {selectedIntake.name}</p>}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setPreviewMode(p => !p)}
                title="Toggle the customer's view"
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${
                  previewMode ? 'bg-blue-600 text-white border-blue-600' : 'bg-bg-2 text-ink-2 border-hairline hover:bg-hairline'
                }`}>
                <Eye className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Preview</span>
              </button>
              <button onClick={() => setPanel(null)} className="text-ink-3 hover:text-ink p-1"><X className="w-5 h-5" /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
          {/* Editor column — while previewing, the toggle swaps to the preview on
              smaller screens; the two-pane (editor beside preview) only kicks in
              at 2xl, where there's room for the widened panel next to the sidebar. */}
          <div className={`overflow-y-auto p-6 space-y-5 scrollbar-thin ${previewMode ? 'hidden 2xl:block 2xl:w-[460px] 2xl:shrink-0 2xl:border-r 2xl:border-hairline' : 'flex-1'}`}>

            {/* Lead's website instant-quote estimate, when building from an intake. */}
            {selectedIntake && (selectedIntake.estimate_min != null || selectedIntake.estimate_max != null) && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                <span className="font-semibold">Website instant quote:</span>{' '}
                {selectedIntake.estimate_min != null && selectedIntake.estimate_max != null
                  ? `$${selectedIntake.estimate_min}–$${selectedIntake.estimate_max}`
                  : `$${selectedIntake.estimate_max ?? selectedIntake.estimate_min}`}
                <span className="text-blue-700"> — pre-filled below; adjust as needed.</span>
              </div>
            )}

            {/* Delivery banner — the last send attempt failed; the quote never
                reached the customer. Cleared automatically on a successful send. */}
            {selected && selected.last_send_error && ['draft', 'sent', 'viewed'].includes(selected.status) && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <div className="font-semibold text-red-800 mb-1">Last send failed — the customer didn't get this quote</div>
                <div className="text-red-900">{selected.last_send_error}</div>
                {selected.last_send_attempt_at && <div className="text-[11px] text-red-700 mt-1">{new Date(selected.last_send_attempt_at).toLocaleString()}</div>}
              </div>
            )}

            {/* Customer response banner — what the customer did with this quote */}
            {selected && selected.requested_changes_message && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <div className="font-semibold text-amber-800 mb-1">Customer requested changes</div>
                <div className="text-amber-900 whitespace-pre-wrap">“{selected.requested_changes_message}”</div>
                {selected.requested_changes_at && <div className="text-[11px] text-amber-700 mt-1">{new Date(selected.requested_changes_at).toLocaleString()}</div>}
              </div>
            )}
            {selected && selected.status === 'accepted' && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
                <div className="font-semibold text-emerald-800">Accepted{selected.accepted_by_name ? ` by ${selected.accepted_by_name}` : ''} ✓</div>
                {selected.accepted_at && <div className="text-[11px] text-emerald-700 mt-0.5">{new Date(selected.accepted_at).toLocaleString()}</div>}
              </div>
            )}
            {selected && selected.status === 'declined' && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <div className="font-semibold text-red-800">Declined{selected.declined_by_name ? ` by ${selected.declined_by_name}` : ''}</div>
                {selected.declined_reason && <div className="text-red-900 mt-0.5">“{selected.declined_reason}”</div>}
                {selected.declined_at && <div className="text-[11px] text-red-700 mt-0.5">{new Date(selected.declined_at).toLocaleString()}</div>}
              </div>
            )}

            {/* Title — shows on the public quote page and in the email header */}
            <div>
              <label className="block text-xs text-ink-3 mb-1">Quote Title</label>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Biweekly cleaning — 12 Pier Rd"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            {/* Client */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-ink-3">Client *</label>
                <button type="button"
                  onClick={() => { setAddingClient(a => !a); setClientErr('') }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                  {addingClient ? 'Cancel' : '+ New client'}
                </button>
              </div>
              {addingClient && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2 mb-2">
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
              <select value={form.client_id} onChange={e => selectClient(e.target.value)}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                <option value="">Select client...</option>
                {(() => {
                  // Dedupe + sort: real names first, placeholders last w/ marker.
                  // Surfaces email/phone so two same-name clients are distinguishable.
                  const isPlaceholder = isPlaceholderName
                  const seen = new Set()
                  const sorted = [...clients].filter(c => {
                    if (seen.has(c.id)) return false
                    seen.add(c.id); return true
                  }).sort((a, b) => {
                    const ap = isPlaceholder(a.name) ? 1 : 0
                    const bp = isPlaceholder(b.name) ? 1 : 0
                    if (ap !== bp) return ap - bp
                    return (a.name || '').localeCompare(b.name || '')
                  })
                  return sorted.map(c => {
                    const tag = isPlaceholder(c.name) ? ' (placeholder)' : ''
                    const contact = [c.email, c.phone].filter(Boolean).join(' · ')
                    const label = `${c.name || '(no name)'}${tag}${contact ? ' — ' + contact : ''}`
                    return <option key={c.id} value={c.id}>{label}</option>
                  })
                })()}
              </select>
            </div>

            {/* Service type */}
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Service Type</label>
              <div className="flex gap-2">
                {SERVICE_TYPES.map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, service_type: t }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${form.service_type === t ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                    {t === 'str' ? 'STR / Vacation' : t}
                  </button>
                ))}
              </div>
            </div>

            {/* Address — structured autocomplete so city/state/zip are captured
                consistently (better dedup + routing) instead of free text. */}
            <div>
              <label className="block text-xs text-ink-3 mb-1">Service Address</label>
              <AddressAutocomplete
                value={form.address}
                onChange={v => setForm(f => ({ ...f, address: v }))}
                onSelect={p => setForm(f => ({ ...f, address: p.address || f.address }))}
                placeholder="123 Main St, Portland, ME 04101"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            {/* Templates */}
            <div>
              <label className="text-xs text-ink-3 block mb-1">Start from template</label>
              <select
                value=""
                onChange={e => {
                  const tpl = quoteTemplates.find(t => t.id === e.target.value)
                  if (!tpl) return
                  setForm(f => ({
                    ...f,
                    service_type: tpl.service_type,
                    items: tpl.items.map(it => ({ ...it })),
                    // Templates carry the full customer experience: title
                    // pattern + default message, so every quote starts
                    // polished. Only fill what the operator hasn't typed.
                    title: f.title || tpl.title || '',
                    customer_message: f.customer_message || tpl.customer_message || '',
                  }))
                  e.target.value = ''
                }}
                className="w-full px-3 py-2 bg-bg-2 border border-hairline-2 rounded-md text-white text-sm"
              >
                <option value="">Custom (build from scratch)</option>
                {quoteTemplates.map(t => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <p className="text-[11px] text-ink-3 mt-1">Pick a template to pre-fill the line items. You can still edit everything.</p>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-ink-3">Line Items</label>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add item
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, i) => (
                  <div key={i} className="bg-bg-2 rounded-lg p-3 space-y-2">
                    <div className="flex gap-2">
                      <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                        placeholder="e.g. Standard Home Clean"
                        className="flex-1 bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none focus:border-blue-400" />
                      <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                        className="text-ink-3 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <input value={item.description} onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Description (optional)"
                      className="w-full bg-bg-2 border border-hairline rounded px-2 py-1.5 text-xs text-ink-3 focus:outline-none" />
                    <div className="flex gap-2">
                      <div className="w-20">
                        <label className="text-xs text-ink-3">Qty</label>
                        <input type="number" inputMode="decimal" min="0" step="0.5" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-ink-3">Unit Price ($)</label>
                        <input type="number" inputMode="decimal" min="0" step="5" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                          className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1 flex flex-col justify-end">
                        <label className="text-xs text-ink-3">Line Total</label>
                        <div className="text-sm font-semibold text-ink mt-1.5">${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax + valid until */}
            <div className="flex gap-3">
              <div className="w-28">
                <label className="block text-xs text-ink-3 mb-1">Tax (%)</label>
                <input type="number" min="0" max="100" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-ink-3 mb-1">Valid Until <span className="text-ink-3/70">(30 days default)</span></label>
                <input type="date" value={form.valid_until} onChange={e => setForm(f => ({ ...f, valid_until: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* Totals summary */}
            <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-ink-3">
                <span>Subtotal</span><span>${subtotal(form.items).toFixed(2)}</span>
              </div>
              {parseFloat(form.tax_rate) > 0 && (
                <div className="flex justify-between text-ink-3">
                  <span>Tax ({form.tax_rate}%)</span><span>${taxAmt(form.items, form.tax_rate).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-ink text-base border-t border-hairline pt-2">
                <span>Total</span><span>${total(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            </div>

            {/* Optional copy (scope, internal notes, customer message) is folded
                away so the everyday quote is just client + items + total. A dot
                flags when any of these actually has content. */}
            <button type="button" onClick={() => setShowQuoteAdvanced(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink">
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showQuoteAdvanced ? 'rotate-90' : ''}`} />
              Scope, notes & customer message
              {!showQuoteAdvanced && (form.notes || form.internal_notes || form.customer_message) && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              )}
            </button>

            {showQuoteAdvanced && (
              <>
                {/* Customer-visible scope */}
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Scope / Notes <span className="text-amber-600 font-medium">(customer sees this)</span></label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                    placeholder="What's included / excluded — shown on the quote the customer opens."
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
                </div>

                {/* Internal notes — operator-only, never rendered to customers */}
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Internal Notes <span className="text-ink-3">(never shown to the customer)</span></label>
                  <textarea value={form.internal_notes} onChange={e => setForm(f => ({ ...f, internal_notes: e.target.value }))} rows={2}
                    placeholder="Lead context, access details, reminders — stays in the app."
                    className="w-full bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
                </div>

                {/* Customer message — the intro paragraph on the public page & email */}
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Message to Customer</label>
                  <textarea value={form.customer_message} onChange={e => setForm(f => ({ ...f, customer_message: e.target.value }))} rows={3}
                    placeholder="Hi! Thanks for reaching out — here's the quote we discussed. Looking forward to working with you."
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
                  <p className="text-[11px] text-ink-3 mt-1">Shown at the top of the emailed quote and the online quote page.</p>
                </div>
              </>
            )}

            {/* Admin-defined custom fields for quotes (renders nothing when none
                are configured in Settings → Custom Fields). */}
            <CustomFieldsForm
              entityType="quote"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />
          </div>

          {/* Preview column — the live customer-facing render. */}
          {previewMode && (
            <div className="flex-1 overflow-y-auto p-6 bg-bg scrollbar-thin">
              <QuotePreview form={form} quoteNumber={selected?.quote_number} company={company} />
            </div>
          )}
          </div>

          {canEdit ? (
            <div className="p-6 border-t border-hairline flex gap-3 shrink-0">
              <button onClick={save} disabled={saving || !form.client_id}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
                {saving ? 'Saving...' : selected ? 'Update Quote' : 'Create Quote'}
              </button>
              {selected && (
                <button onClick={() => openSendPanel(selected)}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
                  <Send className="w-4 h-4" /> Send
                </button>
              )}
            </div>
          ) : (
            <div className="p-6 border-t border-hairline shrink-0 text-xs text-ink-3">Read-only — your role can't edit quotes.</div>
          )}
        </div>
      )}

      {/* Send quote panel */}
      {panel === 'send' && selected && (
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-hairline sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
            <div>
              <h2 className="font-semibold text-ink">Send Quote</h2>
              <p className="text-xs text-ink-3 mt-0.5">{selected.quote_number} · {clientName(selected.client_id)} · ${parseFloat(selected.total || 0).toFixed(2)}</p>
            </div>
            <button onClick={() => setPanel(null)} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Channel selector */}
            <div>
              <label className="block text-xs text-ink-3 mb-2">Send via</label>
              <div className="flex gap-2">
                {[
                  { id: 'email', label: 'Email', icon: Mail },
                  { id: 'sms', label: 'SMS', icon: MessageSquare },
                  { id: 'both', label: 'Both', icon: Send },
                ].map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setSendForm(f => ({ ...f, channel: id }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${sendForm.channel === id ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Email address */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-ink-3 mb-1">Email Address</label>
                <input type="email" value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* Email envelope — subject + greeting, both editable per send */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Email Subject</label>
                  <input value={sendForm.subject} onChange={e => setSendForm(f => ({ ...f, subject: e.target.value }))}
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Greeting Name</label>
                  <input value={sendForm.greeting} onChange={e => setSendForm(f => ({ ...f, greeting: e.target.value }))}
                    placeholder="Leave blank for a plain “Hello,”"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  <p className="text-[11px] text-ink-3 mt-1">The email opens with “Hello {sendForm.greeting.trim() || '…'},”</p>
                </div>
                <div>
                  <label className="block text-xs text-ink-3 mb-1">Send a copy to me</label>
                  <input type="email" value={sendForm.copy_to} onChange={e => setSendForm(f => ({ ...f, copy_to: e.target.value }))}
                    placeholder="you@yourcompany.com"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  <p className="text-[11px] text-ink-3 mt-1">You'll get a blind copy of the quote email. Leave blank to use your company email.</p>
                </div>
              </div>
            )}

            {/* Phone */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-ink-3 mb-1">Phone Number</label>
                <input type="tel" value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+12075551234"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* SMS preview */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <button onClick={() => setPreviewOpen(p => !p)}
                  className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-3 mb-2">
                  <Eye className="w-3.5 h-3.5" /> Preview SMS <ChevronDown className={`w-3 h-3 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
                </button>
                {previewOpen && (
                  <div className="bg-bg-2 rounded-lg p-3 text-xs text-ink-3 whitespace-pre-wrap font-mono border border-hairline">
                    {previewSMS()}
                  </div>
                )}
              </div>
            )}

            {/* Email preview info */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-3">
                <div className="text-xs text-blue-300 font-medium mb-1">Email includes:</div>
                <ul className="text-xs text-blue-400 space-y-0.5">
                  <li>• Quote title, your message, and all line items with totals</li>
                  <li>• Accept / request-changes link to the online quote</li>
                  <li>• Valid-until date (only when the quote has one)</li>
                  <li>• PDF copy attached</li>
                </ul>
              </div>
            )}

            {/* Custom intro message */}
            <div>
              <label className="block text-xs text-ink-3 mb-1">Personal note (optional)</label>
              <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
                rows={3} placeholder="Hi! Great talking with you — here's the quote we discussed..."
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              <p className="text-xs text-ink-3 mt-1">Included at the top of the email and prepended to the SMS. If blank, the quote's "Message to Customer" is used.</p>
            </div>

            {/* Quote summary */}
            <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="text-xs text-ink-3 mb-2">Quote summary</div>
              {(selected.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-ink-3">
                  <span>{item.name} {parseFloat(item.qty) !== 1 ? `×${item.qty}` : ''}</span>
                  <span>${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold text-ink border-t border-hairline pt-2 mt-1">
                <span>Total</span><span>${parseFloat(selected.total || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-hairline shrink-0">
            <button onClick={sendQuote} disabled={sending || (!sendForm.email && !sendForm.phone)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              <Send className="w-4 h-4" />
              {sending ? 'Sending...' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
            </button>
          </div>
        </div>
      )}

      {panel === 'templates' && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center sm:justify-end">
          <div className="w-full sm:w-[520px] bg-panel sm:h-full shadow-2xl flex flex-col max-h-[92vh] sm:max-h-full">
            <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
              <div>
                <h2 className="font-semibold text-ink">Quote templates</h2>
                <p className="text-xs text-ink-3 mt-0.5">Reusable line-item sets for "Start from template" on new quotes.</p>
              </div>
              <button onClick={() => setPanel(null)} className="text-ink-3 hover:text-ink"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
              {editTemplates.length === 0 && <p className="text-sm text-ink-3 text-center py-6">No templates yet — add one below.</p>}
              {editTemplates.map((t, ti) => (
                <div key={ti} className="border border-hairline rounded-xl p-3 space-y-2 bg-bg">
                  <div className="flex items-center gap-2">
                    <input value={t.label} onChange={e => updateTemplate(ti, { label: e.target.value })}
                      placeholder="Template name (e.g. Biweekly Residential)"
                      className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                    <select value={t.service_type} onChange={e => updateTemplate(ti, { service_type: e.target.value })}
                      className="bg-panel border border-hairline rounded-lg px-2 py-2 text-sm focus:outline-none">
                      {SERVICE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button onClick={() => removeTemplate(ti)} title="Delete template"
                      className="p-2 text-ink-3 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  {/* Templates carry the full customer experience: a default
                      quote title + customer message, applied to FUTURE quotes
                      when the template is picked (existing quotes untouched). */}
                  <input value={t.title || ''} onChange={e => updateTemplate(ti, { title: e.target.value })}
                    placeholder="Default quote title (optional — e.g. Biweekly cleaning)"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-400" />
                  <textarea value={t.customer_message || ''} onChange={e => updateTemplate(ti, { customer_message: e.target.value })}
                    placeholder="Default message to customer (optional)" rows={2}
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-400 resize-none" />
                  <div className="space-y-1.5">
                    {(t.items || []).map((it, ii) => (
                      <div key={ii} className="flex items-center gap-1.5">
                        <input value={it.name} onChange={e => updateTplItem(ti, ii, { name: e.target.value })}
                          placeholder="Line item"
                          className="flex-1 bg-panel border border-hairline rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-400" />
                        <input type="number" value={it.qty} onChange={e => updateTplItem(ti, ii, { qty: e.target.value })}
                          title="Qty" className="w-14 bg-panel border border-hairline rounded-lg px-2 py-1.5 text-xs focus:outline-none" />
                        <input type="number" value={it.unit_price} onChange={e => updateTplItem(ti, ii, { unit_price: e.target.value })}
                          title="Unit price" className="w-20 bg-panel border border-hairline rounded-lg px-2 py-1.5 text-xs focus:outline-none" />
                        <button onClick={() => removeTplItem(ti, ii)} className="p-1.5 text-ink-3 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                    <button onClick={() => addTplItem(ti)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add line item</button>
                  </div>
                </div>
              ))}
              <button onClick={addTemplate} className="w-full border border-dashed border-hairline rounded-xl py-2.5 text-sm text-ink-2 hover:bg-bg-2 transition-colors">
                + New template
              </button>
            </div>
            <div className="p-4 border-t border-hairline shrink-0 flex gap-2">
              <button onClick={() => setPanel(null)} className="flex-1 bg-bg-2 hover:bg-hairline text-ink-2 px-4 py-2.5 rounded-lg text-sm font-medium">Cancel</button>
              <button onClick={saveTemplates} disabled={savingTemplates}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
                {savingTemplates ? 'Saving…' : 'Save templates'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scheduleQuote && (
        <JobCreateModal
          clientId={scheduleQuote.client_id}
          clientName={clientName(scheduleQuote.client_id)}
          initialPropertyId={scheduleQuote.property_id || null}
          initialJobType={quoteJobType(scheduleQuote.service_type)}
          initialTitle={scheduleQuote.title || `${clientName(scheduleQuote.client_id)} — Clean`}
          initialQuoteId={scheduleQuote.id}
          initialFrequency={scheduleQuote.frequency || null}
          defaultRecurring
          onClose={() => setScheduleQuote(null)}
          onCreated={finishOnboard}
        />
      )}

      {toast && <Toast msg={toast} />}

    </div>
  )
}
