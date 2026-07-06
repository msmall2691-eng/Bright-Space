import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, Trash2, Calendar, FileText, Search } from 'lucide-react'
import SavedViewsBar from '../components/SavedViewsBar'
import InlineSelect from '../components/InlineSelect'
import JobCreateModal from '../components/JobCreateModal'
import { get, post, patch } from "../api"
import { formatDate } from '../utils/format'
import Toast from '../components/quoting/Toast'
import LeadRow from '../components/quoting/LeadRow'
import QuoteRow from '../components/quoting/QuoteRow'
import FollowUpRow from '../components/quoting/FollowUpRow'
import ArchivedRow from '../components/quoting/ArchivedRow'
import SendQuotePanel from '../components/quoting/SendQuotePanel'
import TemplateManagerModal from '../components/quoting/TemplateManagerModal'
import QuoteEditPanel from '../components/quoting/QuoteEditPanel'
import { useQuotingData, safeQuote } from '../hooks/useQuotingData'
import { useQuotingMutations } from '../hooks/useQuotingMutations'
import {
  QUOTE_STATUS_COLORS, LEAD_STATUS_COLORS,
  QUOTE_STATUS_OPTIONS, LEAD_STATUS_OPTIONS, QUOTE_NEXT_STEP,
  SERVICE_TYPES, EMPTY_ITEM, SERVICE_SCOPE,
  serviceLabel, freqLabel, titleFromIntake, roundTo5, defaultValidUntil,
  isPlaceholderName,
} from '../components/quoting/constants'

// Quote templates (and their prices) live ONLY in the backend
// (/api/settings/quote-templates), which seeds a default set when the admin
// hasn't customized any. We deliberately keep NO hardcoded copy here — a second
// price list in the frontend is a rate card that silently drifts from the
// backend's. Templates load on mount; until then (or if the fetch fails) the
// picker just offers "Custom (build from scratch)".

export default function Quoting() {
  const navigate = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState('leads')
  const {
    quotes, setQuotes,
    followUps, setFollowUps,
    intakes, setIntakes,
    clients, setClients,
    quoteTemplates, setQuoteTemplates,
    templatesLoaded,
    company, companyName,
    archivedQuotes,
    loadQuotes, loadIntakes, loadFollowUps, loadArchived,
  } = useQuotingData()
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
  // The fast path is client → line items → save. Template picker and the
  // scope/internal/message text areas live behind this toggle so the form
  // opens short.
  const [showQuoteAdvanced, setShowQuoteAdvanced] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Template manager (create/edit/delete reusable quote templates). Saving needs
  // admin/manager (PUT is role-gated), so only show the editor to those roles.
  // Quote mutations (create/edit/send/accept/decline/convert) are admin/manager
  // only on the backend — gate the controls so viewers get a read-only funnel
  // instead of buttons that 403. Same check drives the template editor.
  const canEdit = (() => {
    try { return ['admin', 'manager'].includes(JSON.parse(localStorage.getItem('brightbase_user') || '{}').role) }
    catch { return false }
  })()
  const canManageTemplates = canEdit
  // Inline "new client" quick-add from the quote form. addingClient / clientErr
  // are UI-only and live inside QuoteEditPanel; the newClient form + saving
  // flag stay here because `save()` reads them when auto-creating on save.
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  // Whether the "Add client inline" form is expanded in QuoteEditPanel.
  // Lifted from the panel so openFromIntake can auto-expand it when a
  // request has no matched client — previously called an undefined
  // setAddingClient and hard-crashed the whole Billing page.
  const [addingClient, setAddingClient] = useState(false)

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
  // Returns the created client on success or throws. The QuoteEditPanel owns
  // the addingClient/clientErr UI state and clears itself after this resolves.
  const createInlineClient = async () => {
    if (!newClient.name.trim()) throw new Error('Name is required')
    setCreatingClient(true)
    try {
      const created = await post('/api/clients', {
        name: newClient.name.trim(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        status: 'active',
      })
      setClients(cs => [created, ...cs])
      selectClient(String(created.id))
      setNewClient({ name: '', phone: '', email: '' })
      return created
    } finally {
      setCreatingClient(false)
    }
  }

  // Honor ?tab=quotes|leads|follow-ups (e.g. from the dashboard's tiles).
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab')
    if (t === 'quotes' || t === 'leads' || t === 'follow-ups') setTab(t)
    else if (t === 'archived') { setTab('archived'); loadArchived() }
  }, [location.search])

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
      // Resolve a client so "Create Quote" is never stuck on an empty client:
      // use the linked client, else match an existing one by email/phone, else
      // pre-fill + open the inline new-client form so it's a one-tap create.
      const digits = (p) => (p || '').replace(/\D/g, '')
      const matchedClient = clients.find(c =>
        (intake.email && c.email && c.email.toLowerCase() === intake.email.toLowerCase()) ||
        (intake.phone && c.phone && digits(c.phone) === digits(intake.phone)))
      const resolvedClientId = intake.client_id || matchedClient?.id || ''
      if (!resolvedClientId) {
        setNewClient({ name: intake.name || '', phone: intake.phone || '', email: intake.email || '' })
        setAddingClient(true)
      } else {
        setAddingClient(false)
      }
      setForm({
        client_id: resolvedClientId, intake_id: intake.id,
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
    // Greeting uses the linked client's REAL name (authoritative once matched);
    // fall back to the intake's display name only if the client name is missing
    // or a placeholder. Prevents "Hello TEST," when a request used a test label.
    const clientReal = (client?.name || '').trim()
    const intakeName = (intake?.name || '').trim()
    const clientName = !isPlaceholderName(clientReal)
      ? clientReal
      : (!isPlaceholderName(intakeName) ? intakeName : '')
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
    let clientId = form.client_id
    // No client picked yet, but we have new-client details (e.g. a fresh
    // request) — create the client on the fly so "Create Quote" always works
    // instead of dead-ending on a disabled button.
    if (!clientId && newClient.name.trim()) {
      // The clients list may have loaded only after the form opened (the request
      // hand-off mounts this page fresh, so the email/phone match in
      // openQuoteForm ran against an empty list). Re-match here to reuse an
      // existing client instead of creating a duplicate.
      const digits = (p) => (p || '').replace(/\D/g, '')
      const match = clients.find(c =>
        (newClient.email.trim() && c.email && c.email.toLowerCase() === newClient.email.trim().toLowerCase()) ||
        (newClient.phone.trim() && c.phone && digits(c.phone) === digits(newClient.phone)))
      if (match) {
        clientId = match.id
        setForm(f => ({ ...f, client_id: match.id }))
        setAddingClient(false)
      } else {
        setSaving(true)
        try {
          const created = await post('/api/clients', {
            name: newClient.name.trim(),
            phone: newClient.phone.trim() || null,
            email: newClient.email.trim() || null,
            status: 'active',
          })
          setClients(cs => [created, ...cs])
          clientId = created.id
          setForm(f => ({ ...f, client_id: created.id }))
          setAddingClient(false)
        } catch (e) {
          setSaving(false)
          showToast(e.message || 'Could not create the client')
          return
        }
      }
    }
    if (!clientId) { showToast('Please select a client first'); return }
    if (!form.items.length || form.items.every(i => !i.name || !i.name.trim())) { setSaving(false); showToast('Add at least one line item with a name'); return }
    setSaving(true)
    try {
      const body = { ...form, client_id: parseInt(clientId), tax_rate: parseFloat(form.tax_rate) || 0 }
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

  const convertToJob = async (quoteId) => {
    setConverting(quoteId)
    try {
      const job = await post(`/api/quotes/${quoteId}/convert-to-job`)
      showToast('Job created — set the date in Scheduling')
      navigate(`/scheduling`)
    } catch (e) { showToast(e.message || 'Error converting to job') }
    setConverting(null)
  }

  // Permanent (hard) delete is admin-only and lives in the Archived view.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()

  // --- Bulk selection (quotes + archived tabs) ------------------------------
  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const clearSelection = () => setSelectedIds(new Set())

  const {
    updateStatus, markIntakeReviewed, updateLeadStatus,
    archiveQuote, bulkArchive, bulkDeletePermanent, deletePermanent,
    sendFollowUp, copyPublicLink,
    nudging, copiedQuoteId,
  } = useQuotingMutations({
    toast: showToast,
    loadQuotes, loadIntakes, loadFollowUps, loadArchived,
    selectedIds, clearSelection,
    currentSelectedId: selected?.id,
    onSelectedCleared: () => { setSelected(null); setPanel(null) },
  })

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
                onClick={() => setPanel('templates')}
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
              <LeadRow
                key={intake.id}
                intake={intake}
                canEdit={canEdit}
                onUpdateStatus={updateLeadStatus}
                onMarkReviewed={markIntakeReviewed}
                onCreateQuote={(it) => { openQuoteForm(null, it); setTab('quotes') }}
                onOpenClient={(id) => navigate(`/clients/${id}`)}
              />
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
              <QuoteRow
                key={q.id}
                q={q}
                canEdit={canEdit}
                clientName={clientName}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onOpenQuote={openQuoteForm}
                onNavigate={navigate}
                onSend={openSendPanel}
                onCopyLink={copyPublicLink}
                onSchedule={setScheduleQuote}
                onArchive={archiveQuote}
                onUpdateStatus={updateStatus}
                copiedQuoteId={copiedQuoteId}
              />
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
            {followUps.map(q => (
              <FollowUpRow
                key={q.id}
                q={q}
                canEdit={canEdit}
                clientName={clientName}
                nudging={nudging}
                onOpenQuote={openQuoteForm}
                onSendFollowUp={sendFollowUp}
                onOpenSendPanel={openSendPanel}
              />
            ))}
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
              <ArchivedRow
                key={q.id}
                q={q}
                isAdmin={isAdmin}
                clientName={clientName}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onOpenQuote={openQuoteForm}
                onDeletePermanent={deletePermanent}
              />
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
        <QuoteEditPanel
          selected={selected}
          selectedIntake={selectedIntake}
          form={form}
          setForm={setForm}
          clients={clients}
          quoteTemplates={quoteTemplates}
          canEdit={canEdit}
          company={company}
          saving={saving}
          creatingClient={creatingClient}
          newClient={newClient}
          setNewClient={setNewClient}
          addingClient={addingClient}
          setAddingClient={setAddingClient}
          showQuoteAdvanced={showQuoteAdvanced}
          setShowQuoteAdvanced={setShowQuoteAdvanced}
          selectClient={selectClient}
          createInlineClient={createInlineClient}
          updateItem={updateItem}
          onSave={save}
          onClose={() => setPanel(null)}
          onSend={openSendPanel}
        />
      )}

      {panel === 'send' && (
        <SendQuotePanel
          selected={selected}
          clientName={clientName}
          companyName={companyName}
          sendForm={sendForm}
          setSendForm={setSendForm}
          sending={sending}
          onClose={() => setPanel(null)}
          onSend={sendQuote}
        />
      )}

      {panel === 'templates' && (
        <TemplateManagerModal
          initial={quoteTemplates}
          templatesLoaded={templatesLoaded}
          onClose={() => setPanel(null)}
          onSaved={setQuoteTemplates}
          toast={showToast}
        />
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
