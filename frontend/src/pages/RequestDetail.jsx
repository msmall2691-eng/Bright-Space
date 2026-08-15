import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Inbox, Phone, Mail, MapPin, Calendar, DollarSign, FileText,
  UserPlus, Save, Loader2, Home, Building2, Wind, Archive, ArchiveRestore, Trash2,
} from 'lucide-react'
import { get, post, patch, del } from '../api'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import { Card, StatusBadge, Button, EmptyState } from '../components/ui'
import RecordShell from '../components/ui/RecordShell'

// Map a lead status to a StatusBadge variant (matches the Requests list vocab).
const STATUS_VARIANT = {
  new: 'info', reviewed: 'neutral', quoted: 'warning',
  converted: 'success', archived: 'neutral',
}
const SERVICE_ICON = { residential: Home, commercial: Building2, str: Wind }
const money = (n) => (n == null ? null : `$${Number(n).toLocaleString()}`)

/** A labelled field row; renders nothing when the value is empty so the detail
 *  cards don't show a wall of "—". */
function Field({ label, value, icon: Icon }) {
  if (value == null || value === '') return null
  return (
    <div className="flex items-start gap-2 py-1.5">
      {Icon && <Icon className="w-3.5 h-3.5 text-ink-3 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
        <div className="text-sm text-ink break-words">{value}</div>
      </div>
    </div>
  )
}

export default function RequestDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [lead, setLead] = useState(null)
  const [error, setError] = useState(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [converting, setConverting] = useState(null)  // 'client' | 'quote' | null

  const load = useCallback(async () => {
    try {
      const data = await get(`/api/intake/${id}`)
      setLead(data)
      setNotes(data.internal_notes || '')
    } catch (e) {
      setError(e?.message || 'Could not load this request')
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const saveNotes = async () => {
    setSavingNotes(true)
    try {
      await patch(`/api/intake/${id}`, { internal_notes: notes })
      toast.success('Notes saved')
    } catch (e) {
      toast.error(e?.message || 'Could not save notes')
    }
    setSavingNotes(false)
  }

  const convertToClient = async () => {
    setConverting('client')
    try {
      const res = await post(`/api/intake/${id}/convert-to-client`, {})
      toast.success(res.matched_existing ? 'Linked to existing client' : 'Client created from request')
      if (res.client_id) navigate(`/clients/${res.client_id}`)
      else load()
    } catch (e) {
      toast.error(e?.message || 'Convert to client failed')
      setConverting(null)
    }
  }

  // Archive is a status flip (PATCH) — fully reversible, so no dialog; the
  // same button unarchives (back to "reviewed") when the lead is archived.
  const [busy, setBusy] = useState(false)
  const toggleArchived = async () => {
    const next = lead.status === 'archived' ? 'reviewed' : 'archived'
    setBusy(true)
    try {
      await patch(`/api/intake/${id}`, { status: next })
      toast.success(next === 'archived' ? 'Request archived' : 'Request unarchived')
      await load()
    } catch (e) {
      toast.error(e?.message || 'Could not update this request')
    }
    setBusy(false)
  }

  // DELETE /api/intake/{id} is a HARD delete — the original inquiry is gone
  // for good. Records already created from it (client / quote / deal) survive.
  const deleteRequest = async () => {
    const ok = await confirmDialog(
      'Permanently delete this request? The original inquiry — message, contact details, and ' +
      'estimate — is erased and cannot be recovered.\n\n' +
      'Anything already created from it (client, quote, deal) is kept.',
      { title: 'Delete request?', confirmLabel: 'Delete permanently', danger: true }
    )
    if (!ok) return
    setBusy(true)
    try {
      await del(`/api/intake/${id}`)
      toast.success('Request deleted')
      navigate('/requests')
    } catch (e) {
      toast.error(e?.message || 'Could not delete this request')
      setBusy(false)
    }
  }

  const convertToQuote = async () => {
    setConverting('quote')
    try {
      const q = await post(`/api/intake/${id}/convert-to-quote`, {})
      toast.success('Quote created from request')
      if (q?.id) navigate(`/quotes/${q.id}`)
      else load()
    } catch (e) {
      toast.error(e?.message || 'Convert to quote failed')
      setConverting(null)
    }
  }

  if (error) {
    return (
      <RecordShell title="Request" icon={Inbox} backTo="/requests" backLabel="Requests">
        <EmptyState icon={Inbox} title="Couldn’t load this request" description={error} />
      </RecordShell>
    )
  }
  if (!lead) {
    return (
      <RecordShell title="Loading…" icon={Inbox} backTo="/requests" backLabel="Requests">
        <div className="flex items-center gap-2 text-sm text-ink-3 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading request…
        </div>
      </RecordShell>
    )
  }

  const ServiceIcon = SERVICE_ICON[lead.service_type] || Inbox
  const location = [lead.address, lead.city, lead.state, lead.zip_code].filter(Boolean).join(', ')
  const size = [
    lead.bedrooms ? `${lead.bedrooms} bd` : null,
    lead.bathrooms ? `${lead.bathrooms} ba` : null,
    lead.square_footage ? `${Number(lead.square_footage).toLocaleString()} sqft` : null,
  ].filter(Boolean).join(' · ')
  const estimate = (lead.estimate_min != null && lead.estimate_max != null)
    ? `${money(lead.estimate_min)}–${money(lead.estimate_max)}`
    : (money(lead.estimate_min) || money(lead.estimate_max))

  // Related-records rail, built from the backend's `linked` labels.
  const related = [{
    label: 'Linked records',
    items: [
      lead.linked?.client && { type: 'client', id: lead.linked.client.id,
        label: lead.linked.client.name, meta: lead.linked.client.status },
      lead.linked?.opportunity && { type: 'opportunity', id: lead.linked.opportunity.id,
        label: lead.linked.opportunity.title || `Opportunity #${lead.linked.opportunity.id}`,
        meta: lead.linked.opportunity.stage },
      lead.linked?.quote && { type: 'quote', id: lead.linked.quote.id,
        label: `Quote ${lead.linked.quote.number}`, meta: lead.linked.quote.status },
    ].filter(Boolean),
  }]

  const created = lead.created_at ? new Date(lead.created_at).toLocaleDateString() : null

  return (
    <RecordShell
      title={lead.name || lead.email || `Request #${lead.id}`}
      subtitle={[lead.source && `via ${lead.source}`, created && `received ${created}`].filter(Boolean).join(' · ')}
      icon={Inbox} iconColor="violet"
      backTo="/requests" backLabel="Requests"
      status={<StatusBadge status={STATUS_VARIANT[lead.status] || 'neutral'}>{lead.status}</StatusBadge>}
      related={related}
      actions={
        <>
          {/* Delete is hard on the backend — red text on a secondary surface,
              kept left of (and visually apart from) the safe actions. */}
          <button onClick={deleteRequest} disabled={busy || !!converting}
            className="inline-flex items-center justify-center gap-2 rounded-lg font-medium px-3.5 py-2 text-sm text-red-600 hover:text-red-700 bg-panel border border-hairline hover:border-red-300 disabled:opacity-50 transition-colors">
            <Trash2 className="w-4 h-4" /> Delete
          </button>
          <Button variant="secondary" onClick={toggleArchived} disabled={busy || !!converting}
            title={lead.status === 'archived'
              ? 'Put this request back in the active list'
              : 'Set aside without deleting — you can unarchive it any time'}>
            {lead.status === 'archived'
              ? <><ArchiveRestore className="w-4 h-4" /> Unarchive</>
              : <><Archive className="w-4 h-4" /> Archive</>}
          </Button>
          <Button variant="secondary" onClick={convertToClient} disabled={!!converting}>
            {converting === 'client' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Convert to client
          </Button>
          <Button onClick={convertToQuote} disabled={!!converting}>
            {converting === 'quote' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            Create quote
          </Button>
        </>
      }
    >
      {/* Contact */}
      <Card title="Contact" icon={Phone}>
        <div className="px-4 py-2">
          <Field label="Name" value={lead.name} />
          <Field label="Email" value={lead.email} icon={Mail} />
          <Field label="Phone" value={lead.phone} icon={Phone} />
          <Field label="Location" value={location} icon={MapPin} />
        </div>
      </Card>

      {/* Service request */}
      <Card title="Service request" icon={ServiceIcon}>
        <div className="px-4 py-2">
          <Field label="Service" value={lead.requested_service || lead.service_type} icon={ServiceIcon} />
          <Field label="Property size" value={size} icon={Home} />
          <Field label="Frequency" value={lead.frequency} />
          <Field label="Preferred date" value={lead.preferred_date || lead.requested_date} icon={Calendar} />
          <Field label="Check-in / out" value={[lead.check_in, lead.check_out].filter(Boolean).join(' → ')} />
          <Field label="Website estimate" value={estimate} icon={DollarSign} />
        </div>
      </Card>

      {/* Customer message */}
      {lead.message && (
        <Card title="Message" icon={Inbox}>
          <p className="px-4 py-3 text-sm text-ink whitespace-pre-wrap">{lead.message}</p>
        </Card>
      )}

      {/* Internal notes — editable, saved to the lead */}
      <Card title="Internal notes" icon={FileText}>
        <div className="p-4 space-y-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Notes for your team (not shown to the customer)…"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 resize-none"
          />
          <div className="flex justify-end">
            <Button variant="secondary" onClick={saveNotes}
              disabled={savingNotes || notes === (lead.internal_notes || '')}>
              {savingNotes ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save notes
            </Button>
          </div>
        </div>
      </Card>
    </RecordShell>
  )
}
