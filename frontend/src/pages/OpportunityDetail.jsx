import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, FileText, Receipt, Calendar, Loader, Send, TrendingUp,
} from 'lucide-react'
import { get, patch, post } from '../api'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import ActivityTimeline from '../components/ActivityTimeline'
import { EmptyState } from '../components/ui'

// Pipeline stages (mirrors the kanban + backend enum).
const STAGE_OPTIONS = [
  { value: 'new',       label: 'new',       chipClass: 'bg-bg-2 text-ink-2 border-hairline',                    dot: 'bg-ink-3' },
  { value: 'qualified', label: 'qualified', chipClass: 'bg-blue-500/15 text-blue-500 border-blue-500/20',       dot: 'bg-blue-500' },
  { value: 'quoted',    label: 'quoted',    chipClass: 'bg-amber-500/15 text-amber-500 border-amber-500/20',    dot: 'bg-amber-500' },
  { value: 'won',       label: 'won',       chipClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20', dot: 'bg-emerald-500' },
  { value: 'lost',      label: 'lost',      chipClass: 'bg-red-500/15 text-red-500 border-red-500/20',          dot: 'bg-red-500' },
]
const SERVICE_OPTIONS = [
  { value: 'residential', label: 'residential' },
  { value: 'commercial',  label: 'commercial' },
  { value: 'str_turnover', label: 'str turnover' },
  { value: 'deep_clean',  label: 'deep clean' },
]

const money = (n) => n == null || n === '' ? null :
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const fmtDate = (d) => { if (!d) return null; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString() }

const STATUS_CHIP = 'text-[10px] px-2 py-0.5 rounded-full border bg-bg-2 text-ink-3 border-hairline capitalize'

function RelatedList({ icon: Icon, title, items, render, empty }) {
  return (
    <div className="bg-panel border border-hairline rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
          <Icon className="w-3.5 h-3.5 text-ink-3" /> {title}
        </div>
        <span className="text-[11px] text-ink-3">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[12px] text-ink-3 italic py-1">{empty}</div>
      ) : (
        <div className="space-y-1.5">{items.map(render)}</div>
      )}
    </div>
  )
}

export default function OpportunityDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [opp, setOpp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [timelineKey, setTimelineKey] = useState(0)

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/opportunities/${id}/details`)
      .then(d => { setOpp(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])

  // Persist one field; merge the server's response back so derived fields stay
  // in sync. On failure, reload to drop the optimistic value.
  const saveField = (body) =>
    patch(`/api/opportunities/${id}`, body)
      .then(updated => setOpp(o => ({ ...o, ...updated })))
      .catch(load)

  const setStage = (stage) => { setOpp(o => ({ ...o, stage })); saveField({ stage }) }

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    setSavingNote(true)
    try {
      await post(`/api/opportunities/${id}/notes`, { body })
      setNote(''); setTimelineKey(k => k + 1)
    } catch (e) { console.error('[OpportunityDetail] note', e) }
    finally { setSavingNote(false) }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader className="w-6 h-6 animate-spin text-ink-3" /></div>
  }
  if (notFound || !opp) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/pipeline')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Pipeline
        </button>
        <EmptyState icon={TrendingUp} title="Opportunity not found" description="It may have been deleted or moved to another workspace." />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <button onClick={() => navigate('/pipeline')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Pipeline
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: identity + fields ───────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <InlineSelect value={opp.stage} options={STAGE_OPTIONS} onSelect={setStage} />
              </div>
              <InlineEditField label="Deal" value={opp.title} placeholder="Untitled deal"
                onSave={(v) => saveField({ title: v || 'Untitled deal' })} />
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              <InlineEditField label="Amount" type="number" value={opp.amount} placeholder="Add amount"
                format={money} onSave={(v) => saveField({ amount: v == null ? null : Number(v) })} />
              <InlineEditField label="Close date" type="date" value={opp.close_date} placeholder="Add close date"
                format={fmtDate} onSave={(v) => saveField({ close_date: v })} />
              <InlineEditField label="Probability (%)" type="number" value={opp.probability} placeholder="Add %"
                onSave={(v) => saveField({ probability: v == null ? null : Number(v) })} />
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">Service</div>
                <InlineSelect value={opp.service_type || ''} options={SERVICE_OPTIONS}
                  onSelect={(v) => saveField({ service_type: v })} />
              </div>
              <InlineEditField label="Owner" value={opp.owner} placeholder="Assign owner"
                onSave={(v) => saveField({ owner: v })} />
            </div>

            <div className="border-t border-hairline pt-3">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Client</div>
              {opp.client_id ? (
                <Link to={`/clients/${opp.client_id}`}
                  className="flex items-center gap-2 text-[13px] text-blue-500 hover:underline">
                  <Building2 className="w-3.5 h-3.5 shrink-0" /> {opp.client_name || `Client #${opp.client_id}`}
                </Link>
              ) : <span className="text-[12px] text-ink-3 italic">No client linked</span>}
            </div>
          </div>

          {/* ── Center: notes + activity timeline ─────────────────── */}
          <div className="min-w-0 space-y-4">
            <div className="bg-panel border border-hairline rounded-xl p-3">
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Add a note to this deal…"
                rows={2}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote() }}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 resize-y"
              />
              <div className="flex justify-end mt-2">
                <button onClick={addNote} disabled={savingNote || !note.trim()}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors">
                  <Send className="w-3.5 h-3.5" /> {savingNote ? 'Saving…' : 'Add note'}
                </button>
              </div>
            </div>

            <div className="bg-panel border border-hairline rounded-xl p-4">
              <ActivityTimeline key={timelineKey} opportunityId={id} />
            </div>
          </div>

          {/* ── Right: related records ────────────────────────────── */}
          <div className="space-y-4 self-start">
            <RelatedList icon={FileText} title="Quotes" items={opp.quotes || []} empty="No quotes yet"
              render={(q) => (
                <Link key={q.id} to={`/quotes/${q.id}`}
                  className="flex items-center justify-between gap-2 text-[12px] hover:bg-bg-2 rounded px-1 -mx-1 py-0.5 transition-colors">
                  <span className="text-blue-500 truncate hover:underline">{q.quote_number || `#${q.id}`}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-ink-3">{money(q.total)}</span>
                    <span className={STATUS_CHIP}>{q.status}</span>
                  </span>
                </Link>
              )} />
            <RelatedList icon={Receipt} title="Invoices" items={opp.invoices || []} empty="No invoices yet"
              render={(inv) => (
                <Link key={inv.id} to={`/invoices/${inv.id}`}
                  className="flex items-center justify-between gap-2 text-[12px] hover:bg-bg-2 rounded px-1 -mx-1 py-0.5 transition-colors">
                  <span className="text-blue-500 truncate hover:underline">{inv.invoice_number || `#${inv.id}`}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-ink-3">{money(inv.total)}</span>
                    <span className={STATUS_CHIP}>{inv.status}</span>
                  </span>
                </Link>
              )} />
            <RelatedList icon={Calendar} title="Jobs" items={opp.jobs || []} empty="No jobs yet"
              render={(j) => (
                <Link key={j.id} to={`/jobs/${j.id}`}
                  className="flex items-center justify-between gap-2 text-[12px] hover:bg-bg-2 rounded px-1 -mx-1 py-0.5 transition-colors">
                  <span className="text-blue-500 truncate hover:underline">{j.title || `Job #${j.id}`}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-ink-3">{fmtDate(j.scheduled_date)}</span>
                    <span className={STATUS_CHIP}>{j.status}</span>
                  </span>
                </Link>
              )} />
          </div>
        </div>
      </div>
    </div>
  )
}
