import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, MapPin, TrendingUp, Calendar, FileText,
} from 'lucide-react'
import { get, patch, post } from '../api'
import { toast } from '../utils/toastBus'
import { canEdit } from '../utils/perms'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import RecordSkeleton from '../components/record/RecordSkeleton'
import { EmptyState } from '../components/ui'

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
const fmtDate = (d) => { if (!d) return null; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString() }

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
  const [converting, setConverting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/quotes/${id}/details`)
      .then(d => { setQuote(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (quote?.quote_number) document.title = `${quote.quote_number} · Quote` }, [quote?.quote_number])

  const saveField = (body) =>
    patch(`/api/quotes/${id}`, body)
      .then(updated => setQuote(q => ({ ...q, ...updated })))
      .catch(() => { toast.error('Could not save change'); load() })

  const setStatus = (status) => { setQuote(q => ({ ...q, status })); saveField({ status }) }

  // Idempotent on the backend — returns the existing job if already converted.
  const convertToJob = async () => {
    setConverting(true)
    try {
      const job = await post(`/api/quotes/${id}/convert-to-job`, {})
      navigate(`/jobs/${job.id}`)
    } catch { toast.error('Could not convert to job'); setConverting(false) }
  }

  if (loading) return <RecordSkeleton />
  if (notFound || !quote) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/quoting')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Quotes
        </button>
        <EmptyState icon={FileText} title="Quote not found" description="It may have been archived or moved to another workspace." />
      </div>
    )
  }

  const items = quote.items || []

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <button onClick={() => navigate('/quoting')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Quotes
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: fields ──────────────────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <InlineSelect value={quote.status} options={STATUS_OPTIONS} onSelect={setStatus} />
              </div>
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
                <button onClick={convertToJob} disabled={converting}
                  className="w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline disabled:opacity-50 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                  <Calendar className="w-3.5 h-3.5" /> {converting ? 'Converting…' : 'Convert to job'}
                </button>
              </div>
            )}
          </div>

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
          </div>
        </div>
      </div>
    </div>
  )
}
