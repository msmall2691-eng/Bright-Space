import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, MapPin, Receipt, FileText, TrendingUp, Calendar,
  Loader, Send,
} from 'lucide-react'
import { get, patch, post } from '../api'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import ActivityTimeline from '../components/ActivityTimeline'
import { EmptyState } from '../components/ui'

const STATUS_OPTIONS = [
  { value: 'scheduled',   label: 'scheduled',   chipClass: 'bg-blue-500/15 text-blue-500 border-blue-500/20',       dot: 'bg-blue-500' },
  { value: 'in_progress', label: 'in progress', chipClass: 'bg-amber-500/15 text-amber-500 border-amber-500/20',    dot: 'bg-amber-500' },
  { value: 'completed',   label: 'completed',   chipClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20', dot: 'bg-emerald-500' },
  { value: 'cancelled',   label: 'cancelled',   chipClass: 'bg-bg-2 text-ink-3 border-hairline',                    dot: 'bg-ink-3' },
]
const JOB_TYPE_OPTIONS = [
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
      {items.length === 0
        ? <div className="text-[12px] text-ink-3 italic py-1">{empty}</div>
        : <div className="space-y-1.5">{items.map(render)}</div>}
    </div>
  )
}

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

export default function JobDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [timelineKey, setTimelineKey] = useState(0)

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/jobs/${id}/details`)
      .then(d => { setJob(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])

  const saveField = (body) =>
    patch(`/api/jobs/${id}`, body)
      .then(updated => setJob(j => ({ ...j, ...updated })))
      .catch(load)

  const setStatus = (status) => { setJob(j => ({ ...j, status })); saveField({ status }) }

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    setSavingNote(true)
    try {
      await post(`/api/jobs/${id}/notes`, { body })
      setNote(''); setTimelineKey(k => k + 1)
    } catch (e) { console.error('[JobDetail] note', e) }
    finally { setSavingNote(false) }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader className="w-6 h-6 animate-spin text-ink-3" /></div>
  }
  if (notFound || !job) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/schedule')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Schedule
        </button>
        <EmptyState icon={Calendar} title="Job not found" description="It may have been cancelled or moved to another workspace." />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <button onClick={() => navigate('/schedule')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Schedule
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: fields ──────────────────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <Calendar className="w-5 h-5" />
                </div>
                <InlineSelect value={job.status} options={STATUS_OPTIONS} onSelect={setStatus} />
              </div>
              <InlineEditField label="Job" value={job.title} placeholder="Untitled job"
                onSave={(v) => saveField({ title: v || 'Untitled job' })} />
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              <InlineEditField label="Scheduled date" type="date" value={job.scheduled_date} placeholder="Add date"
                format={fmtDate} onSave={(v) => saveField({ scheduled_date: v })} />
              <div className="grid grid-cols-2 gap-2">
                <InlineEditField label="Start" type="time" value={job.start_time} placeholder="--"
                  onSave={(v) => saveField({ start_time: v })} />
                <InlineEditField label="End" type="time" value={job.end_time} placeholder="--"
                  onSave={(v) => saveField({ end_time: v })} />
              </div>
              <InlineEditField label="Address" value={job.address} placeholder="Add address"
                onSave={(v) => saveField({ address: v })} />
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">Job type</div>
                <InlineSelect value={job.job_type || 'residential'} options={JOB_TYPE_OPTIONS}
                  onSelect={(v) => saveField({ job_type: v })} />
              </div>
            </div>

            <div className="border-t border-hairline pt-3">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Client</div>
              {job.client_id ? (
                <Link to={`/clients/${job.client_id}`} className="flex items-center gap-2 text-[13px] text-blue-500 hover:underline">
                  <Building2 className="w-3.5 h-3.5 shrink-0" /> {job.client_name || `Client #${job.client_id}`}
                </Link>
              ) : <span className="text-[12px] text-ink-3 italic">No client linked</span>}
            </div>
          </div>

          {/* ── Center: notes + activity ──────────────────────────── */}
          <div className="min-w-0 space-y-4">
            <div className="bg-panel border border-hairline rounded-xl p-3">
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Add a note to this job…" rows={2}
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
              <ActivityTimeline key={timelineKey} jobId={id} />
            </div>
          </div>

          {/* ── Right: related ────────────────────────────────────── */}
          <div className="space-y-4 self-start">
            <LinkedCard icon={TrendingUp} label="Opportunity"
              to={job.opportunity ? `/opportunities/${job.opportunity.id}` : null}
              primary={job.opportunity?.title} secondary={job.opportunity?.stage} />
            <LinkedCard icon={FileText} label="From quote"
              to={job.quote ? `/quotes/${job.quote.id}` : null}
              primary={job.quote?.quote_number} secondary={job.quote ? money(job.quote.total) : null} />
            <LinkedCard icon={MapPin} label="Property"
              to={job.property ? `/properties/${job.property.id}` : null}
              primary={job.property?.name} secondary={job.property?.address} />
            <RelatedList icon={Receipt} title="Invoices" items={job.invoices || []} empty="No invoices yet"
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
          </div>
        </div>
      </div>
    </div>
  )
}
