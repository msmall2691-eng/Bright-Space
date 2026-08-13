import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, MapPin, Receipt, FileText, TrendingUp, Calendar, Send, Plus, CalendarPlus,
} from 'lucide-react'
import { get, patch, post, download } from '../api'
import { toast } from '../utils/toastBus'
import { formatDateShort as fmtDate } from '../utils/format'
import { canEdit } from '../utils/perms'
import InlineSelect from '../components/InlineSelect'
import InlineEditField from '../components/InlineEditField'
import { AlertCircle, CheckCircle, CalendarClock } from 'lucide-react'
import { computeDisplayStatus } from '../components/schedule/constants'
import Timeline, { jobTimelineSource } from '../components/Timeline'
import RecordSkeleton from '../components/record/RecordSkeleton'
import JobPhotosCard from '../components/schedule/JobPhotosCard'
import { EmptyState } from '../components/ui'

const STATUS_OPTIONS = [
  // "unscheduled" = converted from a quote but no date yet. Distinct badge so
  // an operator can spot date-less jobs at a glance; auto-flips to
  // "scheduled" server-side when a date is saved on the job.
  { value: 'unscheduled', label: 'unscheduled', chipClass: 'bg-amber-500/15 text-amber-600 border-amber-500/30',    dot: 'bg-amber-500' },
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
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    get(`/api/jobs/${id}/details`)
      .then(d => { setJob(d); setNotFound(false) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (job?.title) document.title = `${job.title} · Job` }, [job?.title])

  const saveField = (body) =>
    patch(`/api/jobs/${id}`, body)
      .then(updated => { setJob(j => ({ ...j, ...updated })); return updated })
      .catch(() => { toast.error('Could not save change'); load() })

  const resolveReschedule = (action) =>
    post(`/api/jobs/${id}/${action}-reschedule`, {})
      .then(() => { toast.success(action === 'approve' ? 'Reschedule approved' : 'Request dismissed'); load() })
      .catch((e) => toast.error(e?.message || `Could not ${action} the request`))

  // Show an "invoice this?" banner when a job flips to Completed and doesn't
  // already have an invoice. Cleared once the user acts or dismisses. Audit
  // finding: nothing was connecting job completion to billing, so completed
  // jobs silently didn't get invoiced.
  //
  // The backend now auto-creates a draft invoice on this same PATCH when the
  // job completes (so billing doesn't depend on which "mark complete" UI was
  // used) — wait for that response's `has_invoice` flag before deciding to
  // prompt, instead of checking the stale pre-request `job.invoices`, which
  // could never see an invoice this exact request was about to create.
  const [showInvoicePrompt, setShowInvoicePrompt] = useState(false)
  const setStatus = (status) => {
    const wasCompleting = status === 'completed' && job?.status !== 'completed'
    setJob(j => ({ ...j, status }))
    saveField({ status }).then(updated => {
      if (wasCompleting && !updated?.has_invoice) {
        setShowInvoicePrompt(true)
      }
    })
  }

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    setSavingNote(true)
    try {
      await post(`/api/jobs/${id}/notes`, { body })
      setNote(''); setTimelineKey(k => k + 1)
      toast.success('Note added')
    } catch (e) { toast.error('Could not add note') }
    finally { setSavingNote(false) }
  }

  const addToCalendar = async () => {
    try {
      await download(`/api/reminders/jobs/${id}/invite.ics`, `cleaning-${id}.ics`)
    } catch { toast.error('Could not generate calendar invite') }
  }

  const newInvoice = async () => {
    setCreating(true)
    try {
      // Seed from the linked quote if there is one — a job converted from a
      // $150 quote used to create a $0.00 invoice because we hard-coded
      // unit_price: 0. Fall back to a single $0 line only when no quote
      // exists (rare for real jobs; ad-hoc / STR turnovers without a quote).
      const qItems = job.quote?.items || []
      const items = qItems.length
        ? qItems.map(i => ({
            name: i.name || job.title || 'Cleaning',
            description: i.description || '',
            qty: Number(i.qty) || 1,
            unit_price: Number(i.unit_price) || 0,
          }))
        : [{ name: job.title || 'Cleaning', qty: 1, unit_price: 0 }]
      const inv = await post('/api/invoices', {
        client_id: job.client_id, job_id: job.id,
        items,
        tax_rate: Number(job.quote?.tax_rate) || 0,
      })
      navigate(`/invoices/${inv.id}`)
    } catch { toast.error('Could not create invoice'); setCreating(false) }
  }

  if (loading) return <RecordSkeleton />
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

        {showInvoicePrompt && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="flex items-start gap-2 min-w-0">
              <Receipt className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700" />
              <div className="min-w-0 text-[13px] text-emerald-800">
                <p className="font-semibold">Ready to bill this job?</p>
                <p className="text-emerald-700/90">
                  It's marked complete and doesn't have an invoice yet
                  {job.quote ? ` — we'll copy the ${job.quote.quote_number} line items.` : '.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { setShowInvoicePrompt(false); newInvoice() }}
                disabled={creating}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg"
              >
                {creating ? 'Creating…' : 'Create invoice'}
              </button>
              <button
                onClick={() => setShowInvoicePrompt(false)}
                className="text-[13px] text-emerald-700 hover:text-emerald-800 px-2"
              >
                Not now
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
          {/* ── Left: fields ──────────────────────────────────────── */}
          <div className="bg-panel border border-hairline rounded-xl p-4 space-y-4 self-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-indigo-600/15 text-blue-500 flex items-center justify-center shrink-0">
                  <Calendar className="w-5 h-5" />
                </div>
                <InlineSelect value={job.status} options={STATUS_OPTIONS} onSelect={setStatus} />
              </div>
              {/* Warn when the DB status is 'scheduled' but the job is missing a
                  date, a property, or a crew — so a convert-to-job quote with no
                  time never silently reads as ready-to-run. Lists exactly what's
                  missing so staff know what to fill. */}
              {computeDisplayStatus(job) === 'needs_setup' && (() => {
                const missing = []
                if (!job.scheduled_date) missing.push('a date')
                if (!job.property_id) missing.push('a property')
                if (!(job.cleaner_ids && job.cleaner_ids.length)) missing.push('a crew')
                return (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">Needs setup</p>
                      <p className="text-amber-700/90">
                        This job isn't fully scheduled yet — add {missing.join(' + ')} to make it live.
                      </p>
                    </div>
                  </div>
                )
              })()}
              {/* Customer-link state from the confirm/reschedule page — makes a
                  customer's confirm or reschedule visible in-app, not just in
                  the owner's inbox. A pending reschedule request wins (it needs
                  action); a self-reschedule clears that and lands as confirmed. */}
              {job.reschedule_requested_at ? (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
                  <div className="flex items-start gap-2">
                    <CalendarClock className="w-4 h-4 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {job.reschedule_requested_date ? 'Customer wants to reschedule' : 'Customer asked to reschedule'}
                      </p>
                      {job.reschedule_requested_date && (
                        <p className="text-amber-700/90">
                          To {fmtDate(job.reschedule_requested_date)}
                          {job.reschedule_requested_scope === 'future' ? ' · this + all future visits' : ' · this visit'}
                          {' '}— that slot's busy, so it needs your OK.
                        </p>
                      )}
                      {job.reschedule_request_message && (
                        <p className="text-amber-700/90">“{job.reschedule_request_message}”</p>
                      )}
                      {!job.reschedule_requested_date && (
                        <p className="text-amber-700/90">Pick a new time below (or in the schedule).</p>
                      )}
                    </div>
                  </div>
                  {editable && (
                    <div className="mt-2 flex gap-2">
                      {job.reschedule_requested_date && (
                        <button onClick={() => resolveReschedule('approve')}
                          className="flex-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
                          Approve &amp; move
                        </button>
                      )}
                      <button onClick={() => resolveReschedule('decline')}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-panel border border-amber-300 text-amber-800 font-medium hover:bg-amber-100">
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ) : job.customer_confirmed_at ? (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <p className="font-semibold">Customer confirmed this visit</p>
                </div>
              ) : null}
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
              {canEdit() && job.status === 'scheduled' && (
                /* Open-jobs board (crew app Phase 3): flip to show this job on
                   every cleaner's phone with a Claim button. First claim adds
                   them to the crew and turns this back off automatically. */
                <button
                  onClick={() => saveField({ open_for_claims: !job.open_for_claims })}
                  className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors ${
                    job.open_for_claims
                      ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      : 'border-hairline bg-bg-2 text-ink-2 hover:bg-bg-3'}`}>
                  <span>{job.open_for_claims ? '✨ Up for grabs — crew can claim it' : 'Open for claims'}</span>
                  <span className="text-[10px] uppercase tracking-wide opacity-70">
                    {job.open_for_claims ? 'On · tap to close' : 'Off'}
                  </span>
                </button>
              )}
            </div>

            {(job.crew_responses || []).length > 0 && (
              /* Accept/decline state per assigned cleaner (crew app Phase 2).
                 A decline never unassigns — this list is where the office
                 spots who needs replacing. */
              <div className="border-t border-hairline pt-3">
                <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">Crew responses</div>
                <div className="space-y-1.5">
                  {job.crew_responses.map(r => (
                    <div key={r.cleaner_id} className="text-[12px] flex items-start justify-between gap-2">
                      <span className="text-ink-2 truncate">{r.name}</span>
                      {r.response === 'accepted' ? (
                        <span className="shrink-0 inline-flex items-center gap-1 text-emerald-600 font-semibold">
                          <CheckCircle className="w-3.5 h-3.5" /> Accepted
                        </span>
                      ) : r.response === 'declined' ? (
                        <span className="shrink-0 text-red-600 font-semibold text-right">
                          Can't make it
                          {r.reason && <span className="block font-normal italic text-[11px] text-red-500/90">“{r.reason}”</span>}
                        </span>
                      ) : (
                        <span className="shrink-0 text-ink-3">No answer yet</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-hairline pt-3">
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">Client</div>
              {job.client_id ? (
                <Link to={`/clients/${job.client_id}`} className="flex items-center gap-2 text-[13px] text-blue-500 hover:underline">
                  <Building2 className="w-3.5 h-3.5 shrink-0" /> {job.client_name || `Client #${job.client_id}`}
                </Link>
              ) : <span className="text-[12px] text-ink-3 italic">No client linked</span>}
            </div>

            {canEdit() && (
              <div className="border-t border-hairline pt-3 space-y-2">
                <button onClick={addToCalendar}
                  className="w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                  <CalendarPlus className="w-3.5 h-3.5" /> Add to calendar (.ics)
                </button>
                {job.client_id && (
                  <button onClick={newInvoice} disabled={creating}
                    className="w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline disabled:opacity-50 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                    <Plus className="w-3.5 h-3.5" /> New invoice
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── Center: notes + activity ──────────────────────────── */}
          <div className="min-w-0 space-y-4">
            {job.completion_note && (
              /* Field report left by the cleaner at mark-done. Internal-only —
                 stored on its own column so it can never ride onto an invoice. */
              <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-xl p-3 flex items-start gap-2">
                <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                <div className="min-w-0 text-[13px]">
                  <span className="font-semibold text-emerald-800 dark:text-emerald-300">Crew note</span>
                  <span className="text-ink-2"> — {job.completion_note}</span>
                </div>
              </div>
            )}
            <JobPhotosCard jobId={id} legacy={job.photos_legacy} />
            <div className="bg-panel border border-hairline rounded-xl p-3">
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Add a note to this job…" rows={2}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote() }}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 resize-y"
              />
              <div className="flex justify-end mt-2">
                <button onClick={addNote} disabled={savingNote || !note.trim()}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors">
                  <Send className="w-3.5 h-3.5" /> {savingNote ? 'Saving…' : 'Add note'}
                </button>
              </div>
            </div>
            <div className="bg-panel border border-hairline rounded-xl p-4">
              <Timeline key={timelineKey} source={jobTimelineSource(id)} limit={150} />
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
