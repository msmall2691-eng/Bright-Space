import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, TrendingUp, Calendar, FileText, Receipt, Loader,
} from 'lucide-react'
import { get, patch } from '../api'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import { EmptyState } from '../components/ui'

const STATUS_OPTIONS = [
  { value: 'draft',   label: 'draft',   chipClass: 'bg-bg-2 text-ink-3 border-hairline',                    dot: 'bg-ink-3' },
  { value: 'sent',    label: 'sent',    chipClass: 'bg-blue-500/15 text-blue-500 border-blue-500/20',       dot: 'bg-blue-500' },
  { value: 'overdue', label: 'overdue', chipClass: 'bg-red-500/15 text-red-500 border-red-500/20',          dot: 'bg-red-500' },
  { value: 'paid',    label: 'paid',    chipClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20', dot: 'bg-emerald-500' },
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

export default function InvoiceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [inv, setInv] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/invoices/${id}/details`)
      .then(d => { setInv(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])

  const saveField = (body) =>
    patch(`/api/invoices/${id}`, body)
      .then(updated => setInv(v => ({ ...v, ...updated })))
      .catch(load)

  const setStatus = (status) => { setInv(v => ({ ...v, status })); saveField({ status }) }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader className="w-6 h-6 animate-spin text-ink-3" /></div>
  }
  if (notFound || !inv) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/invoicing')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Invoices
        </button>
        <EmptyState icon={Receipt} title="Invoice not found" description="It may have been deleted or moved to another workspace." />
      </div>
    )
  }

  const items = inv.items || []

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <button onClick={() => navigate('/invoicing')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Invoices
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: fields ──────────────────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <Receipt className="w-5 h-5" />
                </div>
                <InlineSelect value={inv.status} options={STATUS_OPTIONS} onSelect={setStatus} />
              </div>
              <div className="text-[11px] text-ink-3">{inv.invoice_number}</div>
              <div className="text-lg font-semibold text-ink">{money(inv.total)}</div>
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              <InlineEditField label="Due date" type="date" value={inv.due_date} placeholder="Add due date"
                format={fmtDate} onSave={(v) => saveField({ due_date: v })} />
              {inv.paid_at && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">Paid</div>
                  <div className="text-[13px] text-emerald-500">{fmtDate(inv.paid_at)}</div>
                </div>
              )}
            </div>

            <div className="border-t border-hairline pt-3">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Client</div>
              {inv.client_id ? (
                <Link to={`/clients/${inv.client_id}`} className="flex items-center gap-2 text-[13px] text-blue-500 hover:underline">
                  <Building2 className="w-3.5 h-3.5 shrink-0" /> {inv.client_name || `Client #${inv.client_id}`}
                </Link>
              ) : <span className="text-[12px] text-ink-3 italic">No client linked</span>}
            </div>
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
                <div className="flex justify-between text-ink-2"><span>Subtotal</span><span>{money(inv.subtotal)}</span></div>
                <div className="flex justify-between text-ink-2"><span>Tax{inv.tax_rate ? ` (${inv.tax_rate}%)` : ''}</span><span>{money(inv.tax)}</span></div>
                <div className="flex justify-between font-semibold text-ink pt-1 border-t border-hairline"><span>Total</span><span>{money(inv.total)}</span></div>
              </div>
            </div>

            <div className="bg-panel border border-hairline rounded-xl p-4">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Notes</div>
              <InlineEditField label="" value={inv.notes} placeholder="Add a note to this invoice"
                onSave={(v) => saveField({ notes: v })} />
            </div>
          </div>

          {/* ── Right: related ────────────────────────────────────── */}
          <div className="space-y-4 self-start">
            <LinkedCard icon={Calendar} label="Job"
              to={inv.job ? `/jobs/${inv.job.id}` : null}
              primary={inv.job?.title || (inv.job ? `Job #${inv.job.id}` : null)}
              secondary={inv.job ? `${inv.job.status} · ${fmtDate(inv.job.scheduled_date) || 'unscheduled'}` : null} />
            <LinkedCard icon={FileText} label="From quote"
              to={inv.quote ? `/quotes/${inv.quote.id}` : null}
              primary={inv.quote?.quote_number} secondary={inv.quote ? money(inv.quote.total) : null} />
            <LinkedCard icon={TrendingUp} label="Opportunity"
              to={inv.opportunity ? `/opportunities/${inv.opportunity.id}` : null}
              primary={inv.opportunity?.title} secondary={inv.opportunity?.stage} />
          </div>
        </div>
      </div>
    </div>
  )
}
