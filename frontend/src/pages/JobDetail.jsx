import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, MapPin, Receipt, FileText, TrendingUp, Calendar, Send, Plus, CalendarPlus, KeyRound,
  Sparkles, Copy, Check, X, Trash2,
} from 'lucide-react'
import { get, patch, post, del, download } from '../api'
import RecurrenceScopeDialog from '../components/schedule/RecurrenceScopeDialog'
import { rescheduleRecurringVisit } from '../utils/recurringReschedule'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import { formatDateShort as fmtDate } from '../utils/format'
import { canEdit } from '../utils/perms'
import InlineSelect from '../components/InlineSelect'
import CustomerActions from '../components/comms/CustomerActions'

/** Door code + access notes for the job's property, editable in place.
 *  Exists because empty codes were invisible: crew cards correctly show
 *  nothing when there's nothing on file, which read as "the app is broken"
 *  (owner bug report, Aug 2026). Missing fields render as amber fill-me
 *  inputs; a save PATCHes the property, so every future job there has it. */
const ACCESS_FIELDS = [
  ['house_code', 'Door code', 'e.g. 4251#'],
  ['access_notes', 'Access notes', 'e.g. key in lockbox by side door'],
  ['wifi_ssid', 'WiFi network', 'e.g. SeasideCottage'],
  ['wifi_password', 'WiFi password', 'shown on crew cards + offline'],
]

function PropertyAccessCard({ property, canEdit: editable }) {
  const initial = Object.fromEntries(ACCESS_FIELDS.map(([f]) => [f, property[f] || '']))
  const [vals, setVals] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState(null)
  const missing = !saved.house_code && !saved.access_notes

  useEffect(() => {
    get(`/api/crew/properties/${property.id}/notes`).then(setNotes).catch(() => setNotes([]))
  }, [property.id])

  const toggleShare = async (n) => {
    try {
      const updated = await patch(`/api/crew/properties/${property.id}/notes/${n.id}`, { shared: !n.shared })
      setNotes(ns => ns.map(x => (x.id === n.id ? updated : x)))
      toast.success(updated.shared ? 'Shared with the whole crew' : 'Unshared')
    } catch (e) {
      toast.error(e.detail || e.message || 'Could not update')
    }
  }

  const removeNote = async (n) => {
    try {
      await del(`/api/crew/properties/${property.id}/notes/${n.id}`)
      setNotes(ns => ns.filter(x => x.id !== n.id))
    } catch (e) {
      toast.error(e.detail || e.message || 'Could not delete')
    }
  }

  const save = async (field) => {
    const v = vals[field].trim()
    if (v === (saved[field] || '')) return
    setBusy(true)
    try {
      await patch(`/api/properties/${property.id}`, { [field]: v })
      setSaved(s => ({ ...s, [field]: v }))
      toast.success('Saved — crew see it on their next refresh')
    } catch (e) {
      toast.error(e.detail || e.message || 'Could not save')
      setVals(s => ({ ...s, [field]: saved[field] || '' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-hairline bg-panel p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-3 flex items-center gap-1">
        <KeyRound className="w-3 h-3" /> Access — what the crew sees
      </div>
      {missing && (
        <p className="text-[11px] text-ink-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
          Nothing on file — crew cards show no door code for this property.
        </p>
      )}
      {ACCESS_FIELDS.map(([field, label, ph]) => (
        <label key={field} className="block">
          <span className="text-[11px] text-ink-3">{label}</span>
          {editable ? (
            <input value={vals[field]} disabled={busy}
              placeholder={ph}
              onChange={e => setVals(s => ({ ...s, [field]: e.target.value }))}
              onBlur={() => save(field)}
              onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
              className="mt-0.5 w-full bg-bg border border-hairline rounded-lg px-2 py-1.5 text-[12.5px] text-ink focus:outline-none focus:border-amber-400" />
          ) : (
            <div className="text-[12.5px] text-ink">{saved[field] || '—'}</div>
          )}
        </label>
      ))}

      {notes?.length > 0 && (
        /* Crew-sourced house notes: SHARE is the curation step — until then a
           note is author+office only. */
        <div className="border-t border-hairline pt-2 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-ink-3">House notes from the crew</div>
          {notes.map(n => (
            <div key={n.id} className="text-[12px] text-ink-2">
              {n.body}
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-ink-3">{n.author_name}</span>
                {editable && (
                  <>
                    <button onClick={() => toggleShare(n)}
                      className="inline-flex items-center gap-1.5 text-[10px] font-medium rounded-md px-1.5 py-0.5 border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${n.shared ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
                      {n.shared ? 'Shared (tap to unshare)' : 'Share with crew'}
                    </button>
                    <button onClick={() => removeNote(n)}
                      className="text-[10px] text-red-600 underline underline-offset-2">delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
import InlineEditField from '../components/InlineEditField'
import { AlertCircle, CheckCircle, CalendarClock } from 'lucide-react'
import { computeDisplayStatus, FIELD_LABELS } from '../components/schedule/constants'
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

/** Review-request draft, presented like the invoice chaser presents its
 *  drafts: a modal with the editable text. Jobs have no send flow, so the
 *  only affordance is Copy — the operator pastes it into SMS/email along
 *  with the review link. Nothing is sent from here. */
function ReviewDraftModal({ draft, onClose }) {
  const [text, setText] = useState(draft.message)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('Could not copy to clipboard') }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-panel rounded-2xl shadow-2xl border border-hairline max-h-[85dvh] overflow-y-auto overscroll-contain"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Review request draft</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Edit if needed, then copy it into a text or email — add your review link.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5}
            className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-base sm:text-[13px] text-ink focus:outline-none focus:border-indigo-400 resize-none" />
          <div className="flex justify-end mt-2">
            <button onClick={copy}
              className="inline-flex min-h-11 sm:min-h-0 items-center gap-1.5 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md text-xs font-medium px-3 py-1.5 transition-colors">
              {copied ? <><Check className="w-3.5 h-3.5 text-emerald-500" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy message</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
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

  // ── Editing a visit that belongs to a repeating series ───────────────────
  //
  // This page used to PATCH /api/jobs/{id} for EVERY field, including the
  // date — with no scope question and no sign anywhere that the job was part
  // of a series. That is the exact bare-PATCH the recurrence machinery exists
  // to prevent: it orphans the rule's own copy of that date, and the next
  // generation tick puts a duplicate back on the calendar. The Schedule
  // page's drawer and drag-to-reschedule both went through the scope flow;
  // this page, reachable from every visit card, quietly did not.
  //
  // WHICH FIELDS: only date/start/end. Title, address, notes and status
  // describe THIS visit and are safe to patch directly — routing them through
  // a series-wide prompt would be its own kind of wrong.
  const isRecurring = Boolean(job?.recurring_schedule_id)
  const [timingEdit, setTimingEdit] = useState(null)   // pending {date,start,end}
  const [scopeBusy, setScopeBusy] = useState(false)

  const saveTiming = (body) => {
    if (!isRecurring) return saveField(body)
    // Hold the edit and ask what it applies to. Nothing is written until she
    // answers, and cancelling writes nothing at all.
    setTimingEdit(body)
    return Promise.resolve()
  }

  const applyTimingScope = async (scope) => {
    setScopeBusy(true)
    try {
      const { message } = await rescheduleRecurringVisit(scope, {
        schedId: job.recurring_schedule_id,
        originalDate: job.scheduled_date,
        newDate: timingEdit.scheduled_date ?? job.scheduled_date,
        newStart: timingEdit.start_time ?? job.start_time,
        newEnd: timingEdit.end_time ?? job.end_time,
        cleanerIds: job.cleaner_ids || [],
        reason: 'Rescheduled from the job page',
      })
      toast.success(message)
      setTimingEdit(null)
      load()
    } catch (e) {
      toast.error(e?.message || 'Could not move this visit — nothing was changed.')
    } finally {
      setScopeBusy(false)
    }
  }

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

  // AI review-request nudge (completed jobs only) — same review-first draft
  // pattern as the invoice reminder: {subject, message, error?}, sends nothing.
  const [draftingReview, setDraftingReview] = useState(false)
  const [reviewDraft, setReviewDraft] = useState(null)
  const draftReviewRequest = async () => {
    if (draftingReview) return
    setDraftingReview(true)
    try {
      const res = await post(`/api/ai/draft-review-request/${id}`, { channel: 'sms' })
      if (res?.message) setReviewDraft(res)
      else toast.error(res?.error || 'Could not draft a review request')
    } catch (e) { toast.error(e.message || 'Could not draft a review request') }
    setDraftingReview(false)
  }

  const addToCalendar = async () => {
    try {
      await download(`/api/reminders/jobs/${id}/invite.ics`, `cleaning-${id}.ics`)
    } catch { toast.error('Could not generate calendar invite') }
  }

  // DELETE /api/jobs/{id} is a HARD delete on the backend: the job row is
  // removed and its Google Calendar event deleted. The soft path — keep the
  // record, call the visit off — is status → Cancelled, so point there.
  const [deleting, setDeleting] = useState(false)
  const deleteJob = async () => {
    const ok = await confirmDialog(
      'Permanently delete this job? It is removed from BrightBase and taken off the Google Calendar. ' +
      'This cannot be undone.\n\n' +
      'To call the visit off but keep the record, set the status to Cancelled instead.',
      { title: 'Delete job?', confirmLabel: 'Delete permanently', danger: true }
    )
    if (!ok) return
    setDeleting(true)
    try {
      await del(`/api/jobs/${id}`)
      toast.success('Job deleted')
      navigate('/schedule')
    } catch (e) {
      toast.error(e?.message || 'Could not delete job')
      setDeleting(false)
    }
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

  // The reschedule-request banner's approve/dismiss buttons gate on this;
  // it was referenced without ever being defined (a latent ReferenceError
  // whenever a customer reschedule request was pending).
  const editable = canEdit()

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <button onClick={() => navigate('/schedule')} className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Schedule
        </button>

        {showInvoicePrompt && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-panel px-4 py-3">
            <div className="flex items-start gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0 mt-2" aria-hidden="true" />
              <Receipt className="w-4 h-4 shrink-0 mt-0.5 text-ink-3" />
              <div className="min-w-0 text-[13px] text-ink-2">
                <p className="font-semibold text-ink">Ready to bill this job?</p>
                <p className="text-ink-3">
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
                  date or a property — so a convert-to-job quote with no time
                  never silently reads as ready-to-run. Lists exactly what's
                  missing so staff know what to fill.
                  A crew-only gap is NOT this banner: it's the ordinary
                  "not dispatched yet" state and gets the quieter note below
                  (see computeDisplayStatus). */}
              {computeDisplayStatus(job) === 'needs_setup' && (() => {
                const missing = []
                if (!job.scheduled_date) missing.push('a date')
                if (!job.property_id) missing.push('a property')
                return (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
                    <div>
                      <p className="font-semibold text-ink">Needs setup</p>
                      <p className="text-ink-3">
                        This job isn't on the calendar yet — add {missing.join(' + ')} to make it live.
                      </p>
                    </div>
                  </div>
                )
              })()}
              {computeDisplayStatus(job) === 'unassigned' && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-3 shrink-0 mt-1.5" aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-ink">Unassigned</p>
                    <p className="text-ink-3">
                      Date and place are set — nobody's on it yet. Pick a crew when you're ready.
                    </p>
                  </div>
                </div>
              )}
              {/* Customer-link state from the confirm/reschedule page — makes a
                  customer's confirm or reschedule visible in-app, not just in
                  the owner's inbox. A pending reschedule request wins (it needs
                  action); a self-reschedule clears that and lands as confirmed. */}
              {job.reschedule_requested_at ? (
                <div className="mb-3 rounded-lg border border-hairline bg-panel px-3 py-2.5 text-[12px] text-ink-2">
                  <div className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
                    <CalendarClock className="w-4 h-4 shrink-0 mt-0.5 text-ink-3" />
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {job.reschedule_requested_date ? 'Customer wants to reschedule' : 'Customer asked to reschedule'}
                      </p>
                      {job.reschedule_requested_date && (
                        <p className="text-ink-3">
                          To {fmtDate(job.reschedule_requested_date)}
                          {job.reschedule_requested_scope === 'future' ? ' · this + all future visits' : ' · this visit'}
                          {' '}— that slot's busy, so it needs your OK.
                        </p>
                      )}
                      {job.reschedule_request_message && (
                        <p className="text-ink-3">“{job.reschedule_request_message}”</p>
                      )}
                      {!job.reschedule_requested_date && (
                        <p className="text-ink-3">Pick a new time below (or in the schedule).</p>
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
                        className="flex-1 px-3 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 font-medium hover:bg-bg-2">
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ) : job.customer_confirmed_at ? (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                  <p className="font-semibold text-ink">Customer confirmed this visit</p>
                </div>
              ) : null}
              <InlineEditField label="Job" value={job.title} placeholder="Untitled job"
                onSave={(v) => saveField({ title: v || 'Untitled job' })} />
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              {isRecurring && (
                /* Say it BEFORE she edits, not after: this visit is one of a
                   series, and a date change here is a series decision. */
                <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" aria-hidden="true" />
                  <span>
                    This visit repeats.{' '}
                    <Link to={`/recurring?series=${job.recurring_schedule_id}`}
                      className="text-ink hover:text-indigo-600 no-underline font-medium">
                      See the series
                    </Link>
                    {' '}— changing the date or time will ask what it applies to.
                  </span>
                </p>
              )}
              <InlineEditField label="Scheduled date" type="date" value={job.scheduled_date} placeholder="Add date"
                format={fmtDate} onSave={(v) => saveTiming({ scheduled_date: v })} />
              <div className="grid grid-cols-2 gap-2">
                <InlineEditField label="Start" type="time" value={job.start_time} placeholder="--"
                  onSave={(v) => saveTiming({ start_time: v })} />
                <InlineEditField label="End" type="time" value={job.end_time} placeholder="--"
                  onSave={(v) => saveTiming({ end_time: v })} />
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
                      ? 'border-hairline-2 bg-bg-2 text-ink hover:bg-bg-3'
                      : 'border-hairline bg-panel text-ink-2 hover:bg-bg-2'}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${job.open_for_claims ? 'bg-violet-500' : 'bg-ink-3/40'}`} aria-hidden="true" />
                    {job.open_for_claims ? 'Open to crew — they can claim it' : 'Open to crew'}
                  </span>
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
              {/* Reach the customer without leaving the job you're looking at. */}
              {job.client_id && (
                <CustomerActions className="mt-2" clientId={job.client_id}
                  clientName={job.client_name} propertyId={job.property_id}
                  onBooked={load} />
              )}
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
                {job.status === 'completed' && (
                  <button onClick={draftReviewRequest} disabled={draftingReview}
                    title="AI-draft a thank-you + review ask to copy into a text or email"
                    className="w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline disabled:opacity-50 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                    <Sparkles className="w-3.5 h-3.5" /> {draftingReview ? 'Drafting…' : 'Draft review request'}
                  </button>
                )}
              </div>
            )}

            {/* Hard delete lives in its own section, spaced away from the safe
                actions — red text on a secondary surface, never a red primary.
                Cancelling (soft) stays in the status select above. */}
            {canEdit() && (
              <div className="border-t border-hairline pt-3">
                <button onClick={deleteJob} disabled={deleting}
                  className="w-full flex items-center justify-center gap-1.5 bg-bg-2 border border-hairline hover:border-red-300 disabled:opacity-50 text-red-600 hover:text-red-700 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> {deleting ? 'Deleting…' : 'Delete job'}
                </button>
              </div>
            )}
          </div>

          {/* ── Center: notes + activity ──────────────────────────── */}
          <div className="min-w-0 space-y-4">
            {job.completion_note && (
              /* Field report left by the cleaner at mark-done. Internal-only —
                 stored on its own column so it can never ride onto an invoice. */
              <div className="bg-panel border border-hairline rounded-xl p-3 flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0 mt-2" aria-hidden="true" />
                <div className="min-w-0 text-[13px]">
                  <span className="font-semibold text-ink">Crew note</span>
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
            {job.property && (
              <PropertyAccessCard property={job.property} canEdit={canEdit()} />
            )}
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
      {reviewDraft && <ReviewDraftModal draft={reviewDraft} onClose={() => setReviewDraft(null)} />}
      {timingEdit && (
        <RecurrenceScopeDialog
          /* Name what's about to be applied, the same as the edit drawer does —
             picking a blast radius shouldn't mean guessing what's in the blast. */
          fields={Object.keys(timingEdit).map(k => FIELD_LABELS[k]).filter(Boolean)}
          busy={scopeBusy}
          onChoose={applyTimingScope}
          onCancel={() => setTimingEdit(null)}
        />
      )}
    </div>
  )
}
