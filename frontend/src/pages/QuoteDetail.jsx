import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, MapPin, TrendingUp, Calendar, FileText, Inbox,
  Mail, MessageSquare, ChevronRight, Send, Eye, Download, Link2, Check, Sparkles, Archive,
} from 'lucide-react'
import { get, patch, post, del } from '../api'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import { formatDateShort as fmtDate } from '../utils/format'
import { canEdit } from '../utils/perms'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import RecordSkeleton from '../components/record/RecordSkeleton'
import { EmptyState } from '../components/ui'
import JobCreateModal from '../components/JobCreateModal'
import SendQuotePanel from '../components/quoting/SendQuotePanel'
import OriginalRequestCard from '../components/quoting/OriginalRequestCard'
import { isPlaceholderName } from '../components/quoting/constants'

const STATUS_OPTIONS = [
  { value: 'draft',     label: 'draft',     chipClass: 'bg-bg-2 text-ink-3 border-hairline',                    dot: 'bg-ink-3' },
  { value: 'sent',      label: 'sent',      chipClass: 'bg-blue-500/15 text-blue-500 border-blue-500/20',       dot: 'bg-blue-500' },
  { value: 'viewed',    label: 'viewed',    chipClass: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/20',       dot: 'bg-cyan-500' },
  { value: 'accepted',  label: 'accepted',  chipClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20', dot: 'bg-emerald-500' },
  { value: 'declined',  label: 'declined',  chipClass: 'bg-red-500/15 text-red-500 border-red-500/20',          dot: 'bg-red-500' },
  { value: 'converted', label: 'converted', chipClass: 'bg-violet-500/15 text-violet-500 border-violet-500/20', dot: 'bg-violet-500' },
  { value: 'expired',   label: 'expired',   chipClass: 'bg-amber-500/15 text-amber-500 border-amber-500/20',    dot: 'bg-amber-500' },
  { value: 'archived',  label: 'archived',  chipClass: 'bg-bg-2 text-ink-3 border-hairline',                    dot: 'bg-ink-3' },
]
const SERVICE_OPTIONS = [
  { value: 'residential', label: 'residential' },
  { value: 'commercial',  label: 'commercial' },
  { value: 'str_turnover', label: 'str turnover' },
  { value: 'deep_clean',  label: 'deep clean' },
]

const money = (n) => n == null || n === '' ? '$0' :
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function LinkedCard({ icon: Icon, label, to, primary, secondary }) {
  if (!primary) return null
  const inner = (
    <div className="bg-panel border border-hairline rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-3 mb-1">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={`text-[13px] truncate ${to ? 'text-blue-500 hover:underline' : 'text-ink-2'}`}>{primary}</div>
      {secondary && <div className="text-[11px] text-ink-3 truncate">{secondary}</div>}
    </div>
  )
  return to ? <Link to={to}>{inner}</Link> : inner
}

export default function QuoteDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [deliveryHistory, setDeliveryHistory] = useState([])
  const [company, setCompany] = useState({ company_name: 'The Maine Cleaning Co.' })
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sendForm, setSendForm] = useState({
    channel: 'email', email: '', phone: '', custom_message: '', subject: '', greeting: '', copy_to: '',
  })

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/quotes/${id}/details`)
      .then(d => { setQuote(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (id) get(`/api/quotes/${id}/delivery-history`).then(d => setDeliveryHistory(d.history || [])).catch(() => {})
  }, [id])
  // Customer-facing identity for the send panel's subject/copy-to defaults.
  useEffect(() => {
    get('/api/settings/general')
      .then(d => setCompany(c => ({ ...c, ...Object.fromEntries(Object.entries(d || {}).filter(([, v]) => v != null)) })))
      .catch(() => {})
  }, [])
  useEffect(() => { if (quote?.quote_number) document.title = `${quote.quote_number} · Quote` }, [quote?.quote_number])

  const saveField = (body) =>
    patch(`/api/quotes/${id}`, body)
      .then(updated => setQuote(q => ({ ...q, ...updated })))
      .catch(() => { toast.error('Could not save change'); load() })

  // accepted/declined carry real side effects (convert/opportunity/notify), and
  // 'converted' is derived from the convert flow — route them accordingly instead
  // of a raw status PATCH that would bypass all of it (audit item 2).
  const runStatusAction = async (action) => {
    const ok = await confirmDialog(action === 'accept'
      ? 'Mark this quote accepted? This converts it to a job (when a property is linked), marks the deal won, and emails the owner and customer.'
      : 'Mark this quote declined? This closes the deal as lost and notifies the owner.',
      { confirmLabel: action === 'accept' ? 'Accept' : 'Decline' })
    if (!ok) return
    try {
      const updated = await post(`/api/quotes/${id}/${action}`, {})
      setQuote(q => ({ ...q, ...updated }))
    } catch (e) { toast.error(e.message || `Could not ${action} quote`); load() }
  }
  const setStatus = (status) => {
    if (!status || status === quote.status) return
    if (status === 'converted') { toast.error('Use “Convert to job” to convert a quote'); return }
    if (status === 'accepted') return runStatusAction('accept')
    if (status === 'declined') return runStatusAction('decline')
    setQuote(q => ({ ...q, status })); saveField({ status })
  }

  // Ensure a public token exists, returning it (mints one on first use).
  const ensureToken = async () => {
    if (quote.public_token) return quote.public_token
    const { public_token } = await post(`/api/quotes/${id}/generate-token`, {})
    setQuote(q => ({ ...q, public_token }))
    return public_token
  }
  const copyLink = async () => {
    try {
      const token = await ensureToken()
      await navigator.clipboard.writeText(`${window.location.origin}/quote/${token}`)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
      toast.success('Public link copied')
    } catch (e) { toast.error(e.message || 'Could not copy link') }
  }
  const preview = async () => {
    try { window.open(`${window.location.origin}/quote/${await ensureToken()}`, '_blank', 'noopener') }
    catch (e) { toast.error(e.message || 'Could not open preview') }
  }
  const downloadPdf = async () => {
    try { window.open(`${window.location.origin}/api/quotes/public/${await ensureToken()}/pdf?download=1`, '_blank', 'noopener') }
    catch (e) { toast.error(e.message || 'Could not open PDF') }
  }

  const openSend = () => {
    const name = (quote.client_name || '').trim()
    setSendForm({
      channel: 'email',
      email: quote.client_email || '',
      phone: quote.client_phone || '',
      custom_message: '',
      subject: `Your Quote ${quote.quote_number} from ${company.company_name || 'us'}`,
      greeting: isPlaceholderName(name) ? '' : name.split(/\s+/)[0],
      copy_to: company.company_email || '',
    })
    setSendOpen(true)
  }
  // AI follow-up nudge — mirrors the invoice "Draft reminder" flow: the draft
  // lands in the send panel's personal note for review; nothing is sent. The
  // endpoint answers {subject, message, error?} and only for sent/viewed quotes.
  const [drafting, setDrafting] = useState(false)
  const draftFollowup = async () => {
    if (drafting) return
    setDrafting(true)
    try {
      const res = await post(`/api/ai/draft-quote-followup/${id}`, { channel: 'email' })
      if (res?.message) {
        if (!sendOpen) openSend()
        setSendForm(f => ({
          ...f,
          custom_message: res.message,
          ...(res.subject ? { subject: res.subject } : {}),
        }))
        toast.success('Draft ready — review before sending')
      } else {
        toast.error(res?.error || 'Could not draft a follow-up')
      }
    } catch (e) { toast.error(e.message || 'Could not draft a follow-up') }
    setDrafting(false)
  }

  const doSend = async () => {
    setSending(true)
    try {
      await post(`/api/quotes/${id}/generate-token`, {})
      const payload = { ...sendForm, copy_to: (sendForm.copy_to || '').trim() || null }
      const data = await post(`/api/quotes/${id}/send`, payload)
      if (data.delivered) {
        const sent = Object.entries(data.results || {}).filter(([, v]) => v === 'sent').map(([k]) => k)
        toast.success(`Quote sent via ${sent.join(' & ') || 'email'} ✓`)
      } else {
        toast.error(`Couldn't send: ${(data.errors || []).join('; ') || 'delivery failed'}`)
      }
      setSendOpen(false)
      load()
    } catch (e) { toast.error(e.message || 'Error sending quote') }
    setSending(false)
  }

  // Archive = the backend's DELETE /api/quotes/{id}: a soft delete (status →
  // archived, hidden from lists, everything linked preserved). The server 409s
  // on a quote already converted to a job — surface its message verbatim.
  const archiveQuote = async () => {
    const ok = await confirmDialog(
      `Archive quote ${quote.quote_number || ''}?\n\n` +
      'It disappears from your quote lists but nothing is deleted — the quote and its ' +
      'client, request, and deal links are all kept.',
      { title: 'Archive quote?', confirmLabel: 'Archive' }
    )
    if (!ok) return
    try {
      await del(`/api/quotes/${id}`)
      toast.success('Quote archived')
      navigate('/billing?view=quotes&tab=quotes')
    } catch (e) {
      // e.message carries the backend's 409 detail ("…Cancel/delete the job first.")
      toast.error(e?.message || 'Could not archive quote')
    }
  }

  // Convert-to-job opens the modal so the operator can pick a date + crew
  // at conversion time. The modal itself POSTs to the endpoint (idempotent
  // on the backend — returns the existing job if already converted).
  const [convertModalOpen, setConvertModalOpen] = useState(false)
  const openConvertModal = () => setConvertModalOpen(true)

  if (loading) return <RecordSkeleton />
  if (notFound || !quote) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/billing?view=quotes&tab=quotes')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Quotes
        </button>
        <EmptyState icon={FileText} title="Quote not found" description="It may have been archived or moved to another workspace." />
      </div>
    )
  }

  const items = quote.items || []
  const editable = canEdit()
  // 'converted' is derived (set by the convert flow), so it's only offered when
  // the quote is already in that state — never as a manual pick (audit item 2).
  const statusOptions = STATUS_OPTIONS.filter(o => o.value !== 'converted' || quote.status === 'converted')
  // Match the backend send_quote guard exactly: it only accepts draft/sent/viewed
  // (draft = first send; sent/viewed = a follow-up nudge). Any other status —
  // accepted, converted, declined, expired, changes_requested — 400s, so the
  // Send CTA must be disabled for them rather than dead-ending in an error.
  const canSend = ['draft', 'sent', 'viewed', 'changes_requested'].includes(quote.status)
  const emptyQuote = !items.length || Number(quote.total || 0) <= 0
  const sendDisabled = !canSend || emptyQuote
  const sendTitle = !canSend
    ? `A ${quote.status} quote can't be sent.`
    : emptyQuote ? 'Add at least one line item and a total over $0 before sending.' : undefined

  const ToolbarButton = ({ icon: Icon, label, onClick, disabled, title, primary }) => (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        primary ? 'bg-indigo-600 hover:bg-blue-500 text-white' : 'bg-bg-2 hover:bg-bg-3 border border-hairline text-ink-2'}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <button onClick={() => navigate('/billing?view=quotes&tab=quotes')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2">
            <ArrowLeft className="w-4 h-4" /> Back to Quotes
          </button>
          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              <ToolbarButton icon={Send} label={quote.status === 'draft' ? 'Send' : quote.status === 'changes_requested' ? 'Send revised' : 'Resend'} onClick={openSend} primary
                disabled={sendDisabled}
                title={sendTitle} />
              {['sent', 'viewed'].includes(quote.status) && (
                <ToolbarButton icon={Sparkles} label={drafting ? 'Drafting…' : 'Draft follow-up'}
                  onClick={draftFollowup} disabled={drafting}
                  title="AI-draft a friendly nudge — lands in the send panel for review" />
              )}
              <ToolbarButton icon={Eye} label="Preview" onClick={preview} />
              <ToolbarButton icon={Download} label="Download PDF" onClick={downloadPdf} />
              <ToolbarButton icon={copied ? Check : Link2} label={copied ? 'Copied' : 'Copy link'} onClick={copyLink} />
              {/* Red-text secondary, never a red primary — archive is the
                  quote's "remove" (soft; the backend keeps everything). */}
              {quote.status !== 'archived' && (
                <button onClick={archiveQuote}
                  title="Hide this quote from lists — nothing is deleted"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium bg-bg-2 border border-hairline text-red-600 hover:text-red-700 hover:border-red-300 transition-colors">
                  <Archive className="w-3.5 h-3.5" /> Archive
                </button>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: fields ──────────────────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-indigo-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <InlineSelect value={quote.status} options={statusOptions} onSelect={setStatus} />
              </div>
              {quote.viewed_at && (
                <div className="flex items-center gap-1 text-[11px] text-indigo-600 mb-1"
                  title={`Customer opened this quote on ${new Date(quote.viewed_at).toLocaleString()}`}>
                  <Eye className="w-3.5 h-3.5 shrink-0" />
                  Opened by customer · {new Date(quote.viewed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
              <div className="text-[11px] text-ink-3 mb-0.5">{quote.quote_number}</div>
              <InlineEditField label="Title" value={quote.title} placeholder="Untitled quote"
                onSave={(v) => saveField({ title: v })} />
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">Service</div>
                <InlineSelect value={quote.service_type || ''} options={SERVICE_OPTIONS}
                  onSelect={(v) => saveField({ service_type: v })} />
              </div>
              <InlineEditField label="Valid until" type="date" value={quote.valid_until} placeholder="Add date"
                format={fmtDate} onSave={(v) => saveField({ valid_until: v })} />
              <InlineEditField label="Address" value={quote.address} placeholder="Add address"
                onSave={(v) => saveField({ address: v })} />
            </div>

            <div className="border-t border-hairline pt-3">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Client</div>
              {quote.client_id ? (
                <Link to={`/clients/${quote.client_id}`} className="flex items-center gap-2 text-[13px] text-blue-500 hover:underline">
                  <Building2 className="w-3.5 h-3.5 shrink-0" /> {quote.client_name || `Client #${quote.client_id}`}
                </Link>
              ) : <span className="text-[12px] text-ink-3 italic">No client linked</span>}
            </div>

            {canEdit() && !quote.job && quote.status !== 'converted' && (
              <div className="border-t border-hairline pt-3">
                <button onClick={openConvertModal}
                  className="w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                  <Calendar className="w-3.5 h-3.5" /> Convert to job
                </button>
              </div>
            )}
          </div>
          {convertModalOpen && (
            <JobCreateModal
              clientId={quote.client_id}
              clientName={quote.client_name}
              initialPropertyId={quote.property_id || null}
              initialJobType={quote.service_type === 'str' ? 'str_turnover' : quote.service_type === 'commercial' ? 'commercial' : 'residential'}
              initialTitle={quote.title || `${quote.client_name} — Clean`}
              initialQuoteId={quote.id}
              initialFrequency={quote.frequency || null}
              defaultRecurring
              onClose={() => setConvertModalOpen(false)}
              onCreated={async (result) => {
                try { await patch(`/api/quotes/${quote.id}`, { status: 'converted' }) } catch { /* non-fatal */ }
                setConvertModalOpen(false)
                // JobCreateModal's onCreated shape differs by mode: a one-time
                // job lands on its own detail page; a recurring series has no
                // single job yet (generate_jobs runs async), so land on the
                // series instead — matching Quoting.jsx's own finishOnboard,
                // which doesn't attempt to navigate into either.
                if (result?.kind === 'job' && result.job?.id) navigate(`/jobs/${result.job.id}`)
                else if (result?.kind === 'recurring' && result.schedule?.id) navigate(`/recurring?series=${result.schedule.id}`)
              }}
            />
          )}

          {/* ── Center: line items + notes ────────────────────────── */}
          <div className="min-w-0 space-y-4">
            <div className="bg-panel border border-hairline rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-ink-3 border-b border-hairline">
                    <th className="text-left font-medium px-3 py-2">Item</th>
                    <th className="text-right font-medium px-3 py-2 w-14">Qty</th>
                    <th className="text-right font-medium px-3 py-2 w-24">Unit</th>
                    <th className="text-right font-medium px-3 py-2 w-24">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr><td colSpan={4} className="text-center text-ink-3 italic py-6">No line items</td></tr>
                  ) : items.map((it, i) => {
                    const qty = Number(it.qty ?? it.quantity ?? 1)
                    const unit = Number(it.unit_price ?? it.price ?? 0)
                    return (
                      <tr key={i} className="border-b border-hairline/60 last:border-0">
                        <td className="px-3 py-2 text-ink">
                          <div>{it.name || it.description || 'Item'}</div>
                          {it.name && it.description && <div className="text-[11px] text-ink-3">{it.description}</div>}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2">{qty}</td>
                        <td className="px-3 py-2 text-right text-ink-2">{money(unit)}</td>
                        <td className="px-3 py-2 text-right text-ink">{money(qty * unit)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="border-t border-hairline px-3 py-2 space-y-1 text-[13px]">
                <div className="flex justify-between text-ink-2"><span>Subtotal</span><span>{money(quote.subtotal)}</span></div>
                {quote.discount ? <div className="flex justify-between text-ink-2"><span>Discount</span><span>-{money(quote.discount)}</span></div> : null}
                <div className="flex justify-between text-ink-2"><span>Tax{quote.tax_rate ? ` (${quote.tax_rate}%)` : ''}</span><span>{money(quote.tax)}</span></div>
                <div className="flex justify-between font-semibold text-ink pt-1 border-t border-hairline"><span>Total</span><span>{money(quote.total)}</span></div>
              </div>
            </div>

            <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Customer message</div>
                <InlineEditField label="" value={quote.customer_message} placeholder="Add a message shown to the client"
                  onSave={(v) => saveField({ customer_message: v })} />
              </div>
              <div className="border-t border-hairline pt-3">
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Internal notes</div>
                <InlineEditField label="" value={quote.internal_notes} placeholder="Private notes (not shown to client)"
                  onSave={(v) => saveField({ internal_notes: v })} />
              </div>
            </div>
          </div>

          {/* ── Right: related ────────────────────────────────────── */}
          <div className="space-y-4 self-start">
            {/* The original request behind this quote — expanded so staff can
                see what the customer asked for while reviewing/sending. */}
            <OriginalRequestCard intake={quote.intake} defaultOpen className="bg-panel" />
            <LinkedCard icon={Inbox} label="Request"
              to={quote.intake ? `/requests/${quote.intake.id}` : null}
              primary={quote.intake ? (quote.intake.name || `Request #${quote.intake.id}`) : null}
              secondary={quote.intake?.source ? `via ${quote.intake.source}` : null} />
            <LinkedCard icon={TrendingUp} label="Opportunity"
              to={quote.opportunity ? `/opportunities/${quote.opportunity.id}` : null}
              primary={quote.opportunity?.title} secondary={quote.opportunity?.stage} />
            <LinkedCard icon={Calendar} label="Converted job"
              to={quote.job ? `/jobs/${quote.job.id}` : null}
              primary={quote.job?.title || (quote.job ? `Job #${quote.job.id}` : null)}
              secondary={quote.job ? `${quote.job.status} · ${fmtDate(quote.job.scheduled_date) || 'unscheduled'}` : null} />
            <LinkedCard icon={MapPin} label="Property"
              to={quote.property ? `/properties/${quote.property.id}` : null}
              primary={quote.property?.name} secondary={quote.property?.address} />

            {/* Delivery history — diagnostic, collapsed to a summary line. */}
            {deliveryHistory.length > 0 && (
              <details className="group bg-panel border border-hairline rounded-xl p-4">
                <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] uppercase tracking-wide text-ink-3 select-none">
                  <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                  Delivery history
                  <span className="ml-auto normal-case tracking-normal text-ink-2">
                    {deliveryHistory.length} attempt{deliveryHistory.length !== 1 ? 's' : ''}
                  </span>
                </summary>
                <div className="space-y-2 mt-2">
                  {deliveryHistory.map((d, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px]">
                      {d.channel === 'email'
                        ? <Mail className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                        : <MessageSquare className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-ink-2 truncate">{d.recipient}</span>
                          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            d.status === 'sent' || d.status === 'delivered' ? 'bg-emerald-500/15 text-emerald-500'
                            : d.status === 'failed' || d.status === 'bounced' || d.status === 'undelivered' ? 'bg-red-500/15 text-red-500'
                            : 'bg-amber-500/15 text-amber-500'
                          }`}>{d.status}</span>
                        </div>
                        <div className="text-[11px] text-ink-3">{d.sent_at ? new Date(d.sent_at).toLocaleString() : ''}</div>
                        {d.error && <div className="text-[11px] text-red-500 mt-0.5">{d.error}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>

      {sendOpen && (
        <SendQuotePanel
          selected={quote}
          clientName={(cid) => quote.client_name || `Client #${cid}`}
          companyName={company.company_name || 'The Maine Cleaning Co.'}
          sendForm={sendForm}
          setSendForm={setSendForm}
          sending={sending}
          onClose={() => setSendOpen(false)}
          onSend={doSend}
        />
      )}
    </div>
  )
}
