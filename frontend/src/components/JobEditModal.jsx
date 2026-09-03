import { useState, useEffect, useMemo, useRef } from 'react'
import { X, Search, User, Trash2, Ban, ChevronDown } from 'lucide-react'
import { get, patch, post, del } from '../api'
import Button from './ui/Button'
import InlineSelect from './InlineSelect'
import { useEmployees } from '../hooks/useEmployees'
import RecurrenceScopeDialog from './schedule/RecurrenceScopeDialog'
import { isoDateToBackendDow } from '../utils/recurringReschedule'
import { confirmDialog } from '../utils/confirmBus'
import { normalizeEmployee } from '../utils/employees'

// Same dot+word vocabulary as JobDetail's STATUS_OPTIONS — this modal used to
// render status as solid-filled pill buttons (a different idiom from every
// other status control in the app). Kept local rather than importing from
// JobDetail so the two pages don't couple on each other's module.
const STATUS_OPTIONS = [
  { value: 'unscheduled', label: 'unscheduled', dot: 'bg-amber-500' },
  { value: 'scheduled',   label: 'scheduled',   dot: 'bg-blue-500' },
  { value: 'in_progress', label: 'in progress', dot: 'bg-amber-500' },
  { value: 'completed',   label: 'completed',   dot: 'bg-emerald-500' },
  { value: 'cancelled',   label: 'cancelled',   dot: 'bg-ink-3' },
]

// Which fields actually live on the RecurringSchedule row, and so are the only
// ones a "this / this and future / all visits" choice can mean anything for.
// (Cross-checked against ScheduleUpdate + ScheduleSplit in
// backend/modules/recurring/router.py — scheduled_date is here because a day
// move is expressed to the series as days_of_week/day_of_month.)
//
// Everything NOT in this set — status, pay_mode, pay_rate_bump, job_type —
// exists only on the Job row. The series has no column to write them to, so
// asking "does this apply to all future visits?" for a status flip was a
// question with no answer: picking "this and all future" ran a SPLIT (a new
// RecurringSchedule, the old one retired, every future visit cancelled and
// regenerated) and then dropped the field on the floor anyway. Those now take
// the plain single-job PATCH path instead.
const SERIES_FIELDS = new Set([
  'scheduled_date', 'start_time', 'end_time', 'cleaner_ids',
  'title', 'address', 'notes', 'property_id',
])

// What to call each field in the scope dialog, so the operator can see what
// they're about to apply to a whole series before they pick.
const FIELD_LABELS = {
  scheduled_date: 'Date', start_time: 'Start time', end_time: 'End time',
  cleaner_ids: 'Crew', title: 'Title', address: 'Address', notes: 'Notes',
  property_id: 'Property',
}

// Shape shared by `formData` (the live draft) and `saved` (the last value
// actually persisted to the server). Keeping both initialized from the same
// function guarantees they can be compared field-by-field without a shape
// mismatch — see isFieldChanged below.
const initialFieldValues = (j) => ({
  title: j?.title || '',
  job_type: j?.job_type || 'residential',
  pay_mode: j?.pay_mode || 'auto',
  pay_rate_bump: j?.pay_rate_bump ?? '',
  status: j?.status || 'scheduled',
  property_id: j?.property_id || '',
  address: j?.address || '',
  cleaner_ids: j?.cleaner_ids || [],
  notes: j?.notes || '',
  scheduled_date: j?.scheduled_date || '',
  start_time: (j?.start_time || '').slice(0, 5),
  end_time: (j?.end_time || '').slice(0, 5),
})

export default function JobEditModal({ job, properties = [], clients = [], onClose, onSave, notify }) {
  const isNew = !job?.id
  const isRecurring = !isNew && Boolean(job?.recurring_schedule_id)
  // 'edit' | 'delete' | null — which scope prompt (if any) is currently showing.
  const [scopeDialog, setScopeDialog] = useState(null)
  const [formData, setFormData] = useState(() => initialFieldValues(job))
  // Last value actually persisted for an EXISTING, non-recurring job — the
  // baseline isFieldChanged compares against so a field that's blurred
  // without being edited doesn't fire a needless PATCH (or, worse, pop the
  // recurring scope dialog for a no-op "change"). Only saveField() advances
  // this, so a recurring job's SERIES fields never update it mid-session (see
  // commitField's header comment) and the comparison stays pinned to what was
  // on the job when the modal opened, which is exactly the right baseline
  // for "did the user actually change anything since then." A recurring job's
  // per-visit-only fields do go through saveField and do advance it — they're
  // written immediately, so the server value really has moved.
  const [saved, setSaved] = useState(() => initialFieldValues(job))
  // Which series fields the operator has actually edited this session, for a
  // recurring job. performRecurringSave builds its payload from ONLY these.
  // Before this, every scope save shipped title + address + notes + both times
  // + cleaner_ids straight off formData, so editing one field rewrote the
  // series with whatever the modal happened to be holding for the other five —
  // and a "this and all future" on a note tweak split the series in two.
  const [dirtySeriesFields, setDirtySeriesFields] = useState(() => new Set())
  // The exact single-field PATCH body that most recently hit a 409, so
  // "Save anyway" can resubmit precisely that with allow_conflicts — never a
  // stale or unrelated payload.
  const [pendingRetry, setPendingRetry] = useState(null)
  const [cleanerSearch, setCleanerSearch] = useState('')
  const [showCleanerDropdown, setShowCleanerDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Everyday edit = date/time/property/cleaner. Type, status, address override,
  // and notes hide behind this toggle. Auto-open when a job already has notes so
  // nothing the operator wrote is hidden on edit.
  const [showAdvanced, setShowAdvanced] = useState(Boolean(job?.notes))
  // Whether to email the customer a Google Calendar update for THIS edit. Off by
  // default so nudging a visit around the calendar stays silent (the "don't
  // bombard them every time I move it" default); check it to tell the customer.
  const [notifyCustomer, setNotifyCustomer] = useState(false)

  // Cleaner roster comes from the shared useEmployees hook so this modal
  // reuses the same cached /api/dispatch/employees response CalendarView +
  // useScheduleData already have on the wire (audit §18). normalizeEmployee
  // still handles legacy roster shape drift (see utils/employees.js).
  const { employees, loading: loadingCleaners } = useEmployees()
  const cleaners = useMemo(
    () => (employees || []).map(normalizeEmployee).filter(c => c.id),
    [employees]
  )

  // Per-cleaner availability for the current date + time window. Refetched
  // whenever the operator changes the date or time so the picker's status
  // hints stay in sync. Debounced (250ms) so quick edits don't hammer the
  // endpoint. Audit finding: assigning cleaners blind led to double-bookings.
  const [availability, setAvailability] = useState({}) // { [cleanerId]: {status, detail, conflict_job_id} }
  useEffect(() => {
    if (!formData.scheduled_date) { setAvailability({}); return }
    const t = setTimeout(() => {
      const params = new URLSearchParams({ date: formData.scheduled_date })
      if (formData.start_time) params.append('start', formData.start_time)
      if (formData.end_time) params.append('end', formData.end_time)
      if (job?.id) params.append('exclude_job_id', String(job.id))
      get(`/api/jobs/cleaner-availability?${params.toString()}`)
        .then(rows => {
          const map = {}
          for (const r of (Array.isArray(rows) ? rows : [])) map[String(r.cleaner_id)] = r
          setAvailability(map)
        })
        .catch(() => setAvailability({}))
    }, 250)
    return () => clearTimeout(t)
  }, [formData.scheduled_date, formData.start_time, formData.end_time, job?.id])

  // Property-level double-booking: a soft, dismissible heads-up (not a
  // save-blocking error — a property CAN legitimately have two jobs the
  // same day, e.g. a morning turnover + an afternoon deep clean). Tier 1
  // roadmap item: previously only str_turnover got a check at all, and
  // only as a hard 409 on save; this covers every job_type and surfaces
  // proactively while editing, same debounce pattern as cleaner availability.
  const [propertyConflicts, setPropertyConflicts] = useState([])
  const [dismissedPropertyWarning, setDismissedPropertyWarning] = useState(false)
  useEffect(() => {
    setDismissedPropertyWarning(false)
    if (!formData.scheduled_date || !formData.property_id) { setPropertyConflicts([]); return }
    const t = setTimeout(() => {
      const params = new URLSearchParams({
        property_id: String(formData.property_id),
        date: formData.scheduled_date,
      })
      if (formData.start_time) params.append('start', formData.start_time)
      if (formData.end_time) params.append('end', formData.end_time)
      if (job?.id) params.append('exclude_job_id', String(job.id))
      get(`/api/jobs/property-availability?${params.toString()}`)
        .then(res => setPropertyConflicts(Array.isArray(res?.conflicts) ? res.conflicts : []))
        .catch(() => setPropertyConflicts([]))
    }, 250)
    return () => clearTimeout(t)
  }, [formData.scheduled_date, formData.start_time, formData.end_time, formData.property_id, job?.id])

  // Editing keeps ownership consistent: only the job's client's properties
  // are offered (the backend rejects cross-client moves anyway). New jobs see
  // everything — the job adopts the chosen property's client.
  const selectableProperties = (!isNew && job?.client_id)
    ? properties.filter(p => !p.client_id || p.client_id === job.client_id)
    : properties
  const selectedProperty = properties.find(p => p.id === parseInt(formData.property_id))
  const assignedCleaners = cleaners.filter(c => formData.cleaner_ids.includes(c.id))
  const filteredCleaners = cleaners.filter(c =>
    !formData.cleaner_ids.includes(c.id) &&
    c.name.toLowerCase().includes(cleanerSearch.toLowerCase())
  )

  const handlePropertyChange = (e) => {
    const propId = e.target.value
    const prop = properties.find(p => p.id === parseInt(propId))
    // Smart default only — never clobber an address the operator typed.
    const nextAddress = formData.address || prop?.address || ''
    setFormData(prev => ({ ...prev, property_id: propId, address: nextAddress }))
    // One user action (picking a property) can touch two fields at once —
    // commit them together rather than forcing an artificial second PATCH
    // for the address's smart-fill.
    const body = {}
    if (isFieldChanged('property_id', propId)) body.property_id = parseInt(propId) || null
    if (isFieldChanged('address', nextAddress)) body.address = nextAddress
    if (Object.keys(body).length) commitField(body)
  }

  const handleAddCleaner = (cleanerId) => {
    const next = [...formData.cleaner_ids, cleanerId]
    setFormData(prev => ({ ...prev, cleaner_ids: next }))
    setCleanerSearch('')
    setShowCleanerDropdown(false)
    if (isFieldChanged('cleaner_ids', next)) commitField({ cleaner_ids: next })
  }

  const handleRemoveCleaner = (cleanerId) => {
    const next = formData.cleaner_ids.filter(id => id !== cleanerId)
    setFormData(prev => ({ ...prev, cleaner_ids: next }))
    if (isFieldChanged('cleaner_ids', next)) commitField({ cleaner_ids: next })
  }

  // Raw-value comparison against the last-persisted baseline — see `saved`'s
  // header comment. Scalar fields compare as strings (formData/DOM values are
  // sometimes numbers, sometimes strings, e.g. property_id); cleaner_ids
  // compares by array contents.
  const isFieldChanged = (key, rawValue) => (
    key === 'cleaner_ids'
      ? JSON.stringify(rawValue) !== JSON.stringify(saved.cleaner_ids)
      : String(rawValue ?? '') !== String(saved[key] ?? '')
  )

  // Routes one already-confirmed-changed field to the right save mechanism.
  // Called only after the caller has checked isFieldChanged, so every call
  // here represents a real edit.
  //
  //  - New job: no id exists to PATCH yet. formData already holds the draft;
  //    the Create Job button (handleSave/performDirectSave) batches
  //    everything in one POST, unchanged from before this conversion.
  //  - Recurring job, SERIES field (see SERIES_FIELDS): which occurrences the
  //    change applies to is ambiguous (this / this-and-future / all), and
  //    applying it needs the reschedule/split/resync machinery, not a bare
  //    PATCH — so this records the field as dirty and shows the scope dialog;
  //    the write waits for performRecurringSave once the operator resolves it.
  //    formData keeps accumulating edits across dialog cancellations, so
  //    nothing is lost if they "Never mind" and keep editing before finally
  //    choosing a scope.
  //  - Recurring job, per-visit-only field (status, pay_mode, pay_rate_bump,
  //    job_type): falls through to the plain PATCH below. The series has no
  //    such column, so there is nothing for a scope to mean — and the old
  //    behavior of prompting anyway is how a status change ended up splitting
  //    a series in half. See SERIES_FIELDS.
  //  - Otherwise (existing, non-recurring job): PATCH just this field,
  //    immediately — the JobDetail-style auto-save this conversion adds.
  const commitField = (body) => {
    if (isNew) return
    const keys = Object.keys(body)
    if (isRecurring && keys.some(k => SERIES_FIELDS.has(k))) {
      setDirtySeriesFields(prev => {
        const next = new Set(prev)
        for (const k of keys) if (SERIES_FIELDS.has(k)) next.add(k)
        return next
      })
      setScopeDialog('edit')
      return
    }
    saveField(body)
  }

  // Per-field auto-save for an existing, non-recurring job. Success advances
  // `saved` so later edits compare against what's actually on the server; a
  // conflict-shaped error surfaces the same "Save anyway" override the old
  // batch Save offered, scoped to just this field's payload; any other
  // error shows the banner and reverts the optimistic edit so the field
  // doesn't keep displaying a value that silently failed to persist.
  //
  // Queued (not fired directly): the old modal only ever issued one PATCH
  // per click of the global Save button, so requests could never race. Auto-
  // save can now fire several close together (tab through a few fields
  // quickly) — chaining through saveQueueRef keeps them applied in the order
  // the operator made them instead of trusting the network to preserve it.
  const saveQueueRef = useRef(Promise.resolve())
  const saveField = (body, allowConflicts = false) => {
    const run = async () => {
      setSaving(true)
      setError('')
      try {
        const payload = { ...body, notify_customer: notifyCustomer, allow_conflicts: allowConflicts }
        const updated = await patch(`/api/jobs/${job.id}`, payload)
        setConflict(null)
        setPendingRetry(null)
        setSaved(s => ({ ...s, ...body }))
        notifyParent('update', updated)
      } catch (err) {
        const msg = err.message || 'Failed to save job'
        if (/conflict|unavailable|over capacity|time off|already booked/i.test(msg)) {
          setConflict(msg)
          setPendingRetry(body)
        } else {
          setError(msg)
          setFormData(f => {
            const reverted = { ...f }
            for (const k of Object.keys(body)) reverted[k] = saved[k]
            return reverted
          })
        }
      } finally {
        setSaving(false)
      }
    }
    saveQueueRef.current = saveQueueRef.current.then(run)
    return saveQueueRef.current
  }

  // A 409 means a real scheduling conflict (double-booked cleaner, time off,
  // over capacity). The backend supports allow_conflicts to override — offer
  // that explicitly instead of dead-ending the save.
  const [conflict, setConflict] = useState(null)
  const [removing, setRemoving] = useState(false)

  // onSave is invoked with a small envelope describing what changed so the
  // parent can update local state instead of refetching the whole week.
  // Audit §17. `mutated` is the server's response (job row) or null for
  // deletes; `action` lets the parent branch on remove-vs-upsert.
  const notifyParent = (action, mutated) => {
    try { onSave?.({ action, jobId: job?.id, job: mutated || null }) }
    catch { /* onSave was the old zero-arg shape — parent falls back to refetch */ }
  }

  // Hard delete: removes the job AND its Google Calendar event (the backend's
  // DELETE /api/jobs/{id} calls delete_event). Irreversible, so confirm first.
  //
  // A recurring occurrence never goes through a bare DELETE: the daily
  // generation tick treats a hard-deleted row as "never happened" and
  // resurrects it next run. Route through the same skip-exception the
  // /recurring page already uses so the cancellation survives regeneration.
  const handleDelete = async () => {
    if (!job?.id) return
    if (isRecurring) {
      setScopeDialog('delete')
      return
    }
    if (!(await confirmDialog('Delete this job? This permanently removes it and its Google Calendar event.', { confirmLabel: 'Delete', danger: true }))) return
    setRemoving(true)
    setError('')
    try {
      await del(`/api/jobs/${job.id}`)
      notify?.('Job deleted · calendar event removed')
      notifyParent('delete', null)
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to delete job')
      setRemoving(false)
    }
  }

  const handleSkipOccurrence = async () => {
    setScopeDialog(null)
    setRemoving(true)
    setError('')
    try {
      await post(`/api/recurring/${job.recurring_schedule_id}/skip`, {
        exception_date: job.scheduled_date,
        reason: 'Cancelled from the calendar',
      })
      notify?.('This visit was skipped — the recurring schedule is unchanged')
      onSave?.() // series-level change; let the parent refetch rather than patch one visit
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to skip this visit')
      setRemoving(false)
    }
  }

  // Softer option: keep the record but mark it cancelled (the calendar event is
  // updated/removed by the backend on the status change).
  const handleCancelJob = async () => {
    if (!job?.id) return
    if (!(await confirmDialog('Cancel this job? It will be marked cancelled.', { confirmLabel: 'Cancel job', danger: true }))) return
    setRemoving(true)
    setError('')
    // `saved.status` — not `job.status` — reflects what's actually
    // persisted right now: the status field auto-saves independently (see
    // commitField), so the `job` prop can be stale by the time Cancel is
    // clicked in the same session.
    const prevStatus = saved.status
    try {
      const updated = await patch(`/api/jobs/${job.id}`, { status: 'cancelled' })
      // "Removes the fear" (Tier 1 roadmap): an Undo action on the toast
      // reverts to whatever status the job actually had before — the modal
      // is already closed by the time this fires, but notify/notifyParent
      // are plain closures over props that stay valid after unmount.
      notify?.('Job cancelled', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const restored = await patch(`/api/jobs/${job.id}`, { status: prevStatus })
              notifyParent('update', restored || { ...job, status: prevStatus })
              notify?.('Cancellation undone')
            } catch {
              notify?.('Could not undo — edit the job to restore it manually')
            }
          },
        },
      })
      notifyParent('update', updated || { ...job, status: 'cancelled' })
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to cancel job')
      setRemoving(false)
    }
  }

  // Entry point for the Create Job button. Existing jobs never reach this
  // any more: they auto-save per field via commitField/saveField above (this
  // modal's batch-Save-to-per-field-auto-save conversion). A brand-new job
  // has no id to PATCH individual fields against yet, so creation still
  // batches every field into one POST, exactly like the old global Save did.
  const handleSave = async (allowConflicts = false) => {
    if (!formData.property_id) {
      setError('Please select a property')
      return
    }
    if (!formData.scheduled_date) {
      setError('Please pick a date')
      return
    }
    await performDirectSave(allowConflicts)
  }

  const performDirectSave = async (allowConflicts = false) => {
    setSaving(true)
    setError('')
    setConflict(null)
    try {
      const prop = properties.find(p => p.id === parseInt(formData.property_id))
      const payload = {
        title: formData.title || (prop ? `Cleaning \u2014 ${prop.name}` : 'Cleaning'),
        job_type: formData.job_type || 'residential',
        pay_mode: formData.pay_mode || 'auto',
        pay_rate_bump: formData.pay_rate_bump === '' || formData.pay_rate_bump == null
          ? null : Number(formData.pay_rate_bump) || 0,
        status: formData.status || 'scheduled',
        property_id: parseInt(formData.property_id),
        address: formData.address || prop?.address || '',
        cleaner_ids: formData.cleaner_ids,
        notes: formData.notes,
        scheduled_date: formData.scheduled_date || null,
        start_time: formData.start_time || null,
        end_time: formData.end_time || null,
        allow_conflicts: allowConflicts,
      }
      if (prop?.client_id) payload.client_id = prop.client_id
      const created = await post('/api/jobs', payload)
      notifyParent('create', created)
      onClose()
    } catch (err) {
      const msg = err.message || 'Failed to save job'
      // Backend 409s carry the human-readable conflict detail.
      if (/conflict|unavailable|over capacity|time off|already booked/i.test(msg)) {
        setConflict(msg)
      } else {
        setError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  // Routes a recurring job's edit to the mechanism that keeps the series
  // consistent for the chosen scope \u2014 see RecurrenceScopeDialog's header
  // comment for why a bare PATCH is unsafe here.
  const performRecurringSave = async (scope) => {
    setScopeDialog(null)
    setSaving(true)
    setError('')
    setConflict(null)
    try {
      const schedId = job.recurring_schedule_id
      const originalDate = job.scheduled_date
      const originalStart = (job.start_time || '').slice(0, 5)
      const originalEnd = (job.end_time || '').slice(0, 5)
      const newDate = formData.scheduled_date || originalDate
      // Only fields the operator actually touched are in play. `dirty` gates
      // every payload below so a scope save can't carry an untouched field's
      // current value onto the series (see dirtySeriesFields).
      const dirty = (k) => dirtySeriesFields.has(k)
      const dateChanged = dirty('scheduled_date') && newDate !== originalDate
      const timeChanged = (dirty('start_time') && formData.start_time !== originalStart)
        || (dirty('end_time') && formData.end_time !== originalEnd)

      // Note there is no Job-only payload to assemble here: status, pay_mode,
      // pay_rate_bump and job_type never reach this function any more — they
      // auto-save through saveField() the moment they're changed, because they
      // have no series meaning to scope (see SERIES_FIELDS). Everything below
      // is series work.

      // Series fields the operator changed, in the shape both /split and
      // PATCH /recurring/{id} accept.
      const seriesPayload = {}
      if (dirty('title')) seriesPayload.title = formData.title
      if (dirty('address')) seriesPayload.address = formData.address
      if (dirty('notes')) seriesPayload.notes = formData.notes
      if (dirty('cleaner_ids')) seriesPayload.cleaner_ids = formData.cleaner_ids
      if (dirty('property_id')) seriesPayload.property_id = parseInt(formData.property_id) || null
      if (dirty('start_time') && formData.start_time) seriesPayload.start_time = formData.start_time
      if (dirty('end_time') && formData.end_time) seriesPayload.end_time = formData.end_time

      // Nothing series-shaped was touched, so there is nothing for a scope to
      // apply. Can't normally happen (only a SERIES_FIELDS edit opens the
      // dialog) but a split/resync on an empty payload is destructive enough
      // to be worth refusing outright rather than trusting that invariant.
      if (!Object.keys(seriesPayload).length && !dateChanged && !timeChanged) {
        setDirtySeriesFields(new Set())
        onClose()
        return
      }

      if (scope === 'this') {
        if (dateChanged || timeChanged) {
          const res = await post(`/api/recurring/${schedId}/reschedule`, {
            exception_date: originalDate,
            rescheduled_date: newDate,
            // Sent whether or not they were edited: an exception row IS the
            // per-occurrence copy of these, and omitting one makes
            // _reschedule_occurrence fall back to the SERIES value — which
            // would quietly discard an override this occurrence already had.
            // formData holds the job's own values when untouched, so this is
            // "keep what this visit has" in the unedited case.
            rescheduled_start_time: formData.start_time || null,
            rescheduled_end_time: formData.end_time || null,
            cleaner_ids: formData.cleaner_ids,
            reason: 'Edited from the calendar (this visit only)',
            notify_customer: notifyCustomer,
          })
          // The exception model has no title/notes/address/property/job_type/
          // status columns \u2014 those land on the materialized Job via a
          // follow-up PATCH.
          const extra = {}
          if (dirty('title')) extra.title = formData.title
          if (dirty('address')) extra.address = formData.address
          if (dirty('notes')) extra.notes = formData.notes
          if (dirty('property_id')) extra.property_id = parseInt(formData.property_id) || null
          // Status is the one per-visit field that can be lost here: it
          // auto-saved onto the occurrence the reschedule above just
          // cancelled, and the replacement Job is born 'scheduled'. Re-apply
          // it so "mark it done, then move it" doesn't quietly revert.
          // (`job` is the prop, still the pre-edit row, so this compares
          // against what the visit had when the modal opened.)
          if (formData.status && formData.status !== job.status) extra.status = formData.status
          if (res?.job_id && Object.keys(extra).length) {
            await patch(`/api/jobs/${res.job_id}`, extra)
          }
        } else {
          // No date/time change \u2014 a normal PATCH can't create the
          // duplicate-occurrence footgun, so skip the exception machinery.
          const body = {}
          if (dirty('title')) body.title = formData.title
          if (dirty('address')) body.address = formData.address
          if (dirty('notes')) body.notes = formData.notes
          if (dirty('cleaner_ids')) body.cleaner_ids = formData.cleaner_ids
          if (dirty('property_id')) body.property_id = parseInt(formData.property_id) || null
          if (Object.keys(body).length) await patch(`/api/jobs/${job.id}`, body)
        }
        notify?.('Updated this visit only \u2014 the rest of the series is unchanged')
      } else if (scope === 'future') {
        // split_date is BOTH the old schedule's cutoff and the new
        // schedule's floor (see modules/recurring/router.py's
        // split_schedule) \u2014 anchoring it on originalDate alone breaks when
        // the visit moved EARLIER (e.g. Wednesday \u2192 the same week's Monday):
        // the new schedule's floor would exclude the target Monday and that
        // occurrence would vanish for a full cycle. Use whichever date is
        // earlier so both the old occurrence's cleanup and the new
        // occurrence's generation land on the correct side of the boundary.
        const splitDate = dateChanged && newDate < originalDate ? newDate : originalDate
        const payload = { ...seriesPayload, split_date: splitDate }
        // Only override the day pattern when the occurrence actually moved
        // to a different day \u2014 a pure time/crew edit shouldn't touch a
        // monthly schedule's day-of-month (or a weekly one's day-of-week) by
        // accident. Both fields are sent together: generate_dates reads
        // whichever one matches the schedule's own frequency and ignores
        // the other, so this is correct regardless of frequency without
        // needing to know it here.
        if (dateChanged) {
          const dow = isoDateToBackendDow(newDate)
          payload.days_of_week = [dow]
          payload.day_of_week = dow
          payload.day_of_month = new Date(`${newDate}T00:00:00`).getDate()
        }
        await post(`/api/recurring/${schedId}/split`, payload)
        notify?.('Updated this visit and every future one in the series')
      } else if (scope === 'all') {
        const payload = { ...seriesPayload, resync: true }
        if (dateChanged) {
          const dow = isoDateToBackendDow(newDate)
          payload.days_of_week = [dow]
          payload.day_of_week = dow
          payload.day_of_month = new Date(`${newDate}T00:00:00`).getDate()
        }
        const res = await patch(`/api/recurring/${schedId}`, payload)
        notify?.(`Updated the whole series (${res?.resynced_jobs || 0} upcoming visit(s) re-synced)`)
      }
      setDirtySeriesFields(new Set())
      onSave?.() // series-level change (possibly many jobs) \u2014 let the parent refetch
      onClose()
    } catch (err) {
      const msg = err.message || 'Failed to save this recurring job'
      if (/conflict|unavailable|over capacity|time off|already booked/i.test(msg)) {
        setConflict(msg)
      } else {
        setError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleScopeChoice = (scope) => {
    if (scopeDialog === 'delete') {
      handleSkipOccurrence()
    } else {
      performRecurringSave(scope)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* Right-side drawer (Twenty-style): full-height, slides over the record */}
      <div className="relative h-full w-full sm:max-w-lg bg-panel shadow-2xl flex flex-col overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-hairline p-4 sm:p-6">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-lg sm:text-xl font-semibold text-ink truncate">{isNew ? "New Job" : "Edit Job"}</h2>
            {isRecurring && (
              <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500" aria-hidden="true" />
                Repeating visit
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!isNew && saving && (
              <span className="text-[11px] text-ink-3">Saving…</span>
            )}
            <button onClick={onClose} className="p-2 -mr-2 text-ink-3 hover:text-ink hover:bg-bg-2 rounded-lg transition-colors" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-y-auto overscroll-contain flex-1 p-4 sm:p-6 space-y-6">
          {/* Status pills — primary control on existing jobs, was buried
              under "Advanced options" per the audit. New jobs default to
              Scheduled with no picker so the create flow stays compact.
              "Unscheduled" is the auto-set status for date-less converted
              quotes (added upstream); flips to Scheduled server-side when
              a date is saved. */}
          {!isNew && (
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Status</label>
              <InlineSelect value={formData.status} options={STATUS_OPTIONS}
                onSelect={(v) => {
                  setFormData(f => ({ ...f, status: v }))
                  if (isFieldChanged('status', v)) commitField({ status: v })
                }} />
            </div>
          )}

          {/* Title — editable on EVERY job, not just new ones. Auto-saves on
              blur for an existing, non-recurring job (falls back to the
              property-derived default just like the old batch Save did if
              left blank); a recurring job's blur opens the scope dialog
              instead of writing directly — see commitField. */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-2">Job Title</label>
            <input
              type="text"
              value={formData.title}
              onChange={e => setFormData(f => ({ ...f, title: e.target.value }))}
              onBlur={() => {
                const prop = properties.find(p => p.id === parseInt(formData.property_id))
                const value = formData.title || (prop ? `Cleaning — ${prop.name}` : 'Cleaning')
                if (value !== formData.title) setFormData(f => ({ ...f, title: value }))
                if (isFieldChanged('title', value)) commitField({ title: value })
              }}
              placeholder="Job title (auto-fills from property if blank)"
              className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base font-medium"
            />
          </div>

          {/* Date + times — finally editable. Each commits independently the
              moment it changes (a native date/time picker's onChange already
              means "the operator picked a final value", unlike free text). */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-sm font-semibold text-ink-2 mb-2">Date</label>
              <input
                type="date"
                value={formData.scheduled_date || ''}
                onChange={e => {
                  const v = e.target.value
                  setFormData(f => ({ ...f, scheduled_date: v }))
                  if (isFieldChanged('scheduled_date', v)) commitField({ scheduled_date: v || null })
                }}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Start</label>
              <input
                type="time"
                value={formData.start_time || ''}
                onChange={e => {
                  const v = e.target.value
                  setFormData(f => ({ ...f, start_time: v }))
                  if (isFieldChanged('start_time', v)) commitField({ start_time: v || null })
                }}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">End</label>
              <input
                type="time"
                value={formData.end_time || ''}
                onChange={e => {
                  const v = e.target.value
                  setFormData(f => ({ ...f, end_time: v }))
                  if (isFieldChanged('end_time', v)) commitField({ end_time: v || null })
                }}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              />
            </div>
          </div>

          {/* Notify-customer toggle — off by default so shuffling a visit's
              date/time doesn't fire a Google Calendar update email every time.
              Check it when the move is one the customer should hear about.
              Existing jobs only: a brand-new job's invite follows the normal
              booking settings. */}
          {!isNew && (
            <label className="flex items-start gap-2 -mt-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={notifyCustomer}
                onChange={e => setNotifyCustomer(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-hairline text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-xs text-ink-2">
                Notify customer of this change
                <span className="block text-ink-3">Off by default — checking it sends a Google Calendar update email.</span>
              </span>
            </label>
          )}

          {/* Property Picker */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-3">
              Property <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.property_id}
              onChange={handlePropertyChange}
              className="w-full px-4 py-3 sm:py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
            >
              <option value="">Select a property...</option>
              {selectableProperties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} • {p.address}
                </option>
              ))}
            </select>
            {selectedProperty && (
              <p className="text-xs text-ink-3 mt-2">
                Type: <span className="font-semibold capitalize">{selectedProperty.property_type}</span>
              </p>
            )}
          </div>

          {/* Property double-booking heads-up — soft warning, never blocks
              Save. A property can legitimately have more than one job the
              same day (morning turnover + afternoon deep clean), so this is
              informational and dismissible, not a validation error. */}
          {!dismissedPropertyWarning && propertyConflicts.length > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-panel px-3 py-2.5 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-ink">
                  {propertyConflicts.some(c => c.overlaps) ? 'Overlapping job at this property' : 'Another job at this property that day'}
                </p>
                <ul className="mt-1 space-y-0.5 text-ink-2">
                  {propertyConflicts.map(c => (
                    <li key={c.job_id} className="truncate">
                      {c.title}{c.start_time ? ` · ${c.start_time.slice(0, 5)}–${(c.end_time || '').slice(0, 5)}` : ''}
                      {c.overlaps && <span className="font-semibold"> (overlaps)</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                onClick={() => setDismissedPropertyWarning(true)}
                className="shrink-0 p-1 text-ink-3 hover:text-ink-2"
                aria-label="Dismiss warning"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Cleaner Selector */}
          <div>
            <label className="block text-sm font-semibold text-ink-2 mb-3">
              <User className="w-4 h-4 inline mr-1" />
              Assign Cleaners
            </label>

            {/* Assigned Cleaners Chips */}
            {assignedCleaners.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {assignedCleaners.map(cleaner => (
                  <div key={cleaner.id} className="flex items-center gap-1.5 bg-bg-2 border border-hairline-2 text-ink-2 px-2.5 py-1.5 rounded-md text-xs sm:text-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                    <span className="truncate">{cleaner.name}</span>
                    <button
                      onClick={() => handleRemoveCleaner(cleaner.id)}
                      className="ml-0.5 hover:text-red-500 rounded-full p-0.5 -mr-1"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Search & Add Cleaners */}
            <div className="relative">
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder={loadingCleaners ? 'Loading cleaners…' : (cleaners.length === 0 ? 'No cleaners available' : 'Search cleaners…')}
                    value={cleanerSearch}
                    onChange={(e) => setCleanerSearch(e.target.value)}
                    onFocus={() => setShowCleanerDropdown(true)}
                    disabled={loadingCleaners || cleaners.length === 0}
                    className="w-full pl-10 pr-4 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base disabled:bg-bg disabled:text-ink-3"
                  />
                </div>
              </div>

              {/* Dropdown — each row carries an availability hint sourced
                  from /api/jobs/cleaner-availability so the operator isn't
                  picking blind. Conflicts render red + secondary text; same-
                  day (no time overlap) renders amber; time-off greyed. */}
              {showCleanerDropdown && filteredCleaners.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-panel border border-hairline rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {filteredCleaners.map(cleaner => {
                    const a = availability[String(cleaner.id)]
                    const status = a?.status
                    const rowCls = status === 'conflict' || status === 'off' || status === 'unavailable'
                      ? 'hover:bg-red-50 dark:hover:bg-red-500/10'
                      : status === 'same_day'
                        ? 'hover:bg-amber-50 dark:hover:bg-amber-500/10'
                        : 'hover:bg-bg-2'
                    const hintCls = status === 'conflict' || status === 'off' || status === 'unavailable'
                      ? 'text-red-600' : status === 'same_day'
                        ? 'text-amber-700'
                        : status === 'usually_off' ? 'text-ink-3' : 'text-emerald-600'
                    const dotCls = status === 'conflict' || status === 'off' || status === 'unavailable'
                      ? 'bg-red-500' : status === 'same_day'
                        ? 'bg-amber-500'
                        : status === 'usually_off' ? 'bg-ink-3' : 'bg-emerald-500'
                    /* Known statuses render their detail; anything the server
                       adds later degrades to NO hint, never to green "Free" —
                       an unrecognized "can't work" must not read as available. */
                    const hintLabel = ['conflict', 'off', 'same_day', 'unavailable', 'usually_off'].includes(status)
                      ? a.detail
                      : (!status && formData.scheduled_date) ? 'Free' : ''
                    return (
                      <button
                        key={cleaner.id}
                        onClick={() => handleAddCleaner(cleaner.id)}
                        className={`w-full text-left px-4 py-3 text-ink text-sm transition-colors first:rounded-t-lg last:rounded-b-lg active:bg-bg-2 flex items-center justify-between gap-2 ${rowCls}`}
                      >
                        <span className="truncate">{cleaner.name}</span>
                        {hintLabel && (
                          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium shrink-0 ${hintCls}`}>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`} aria-hidden="true" />
                            {hintLabel}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {!loadingCleaners && cleaners.length === 0 && (
                <p className="text-xs text-ink-3 mt-2">
                  No cleaners on the roster yet. Add your crew on the Crew page.
                </p>
              )}
            </div>

            {assignedCleaners.length === 0 && (
              <p className="text-xs text-ink-3 mt-2 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                No cleaners assigned
              </p>
            )}
          </div>

          {/* Advanced options — type, status, address override, notes.
              Rarely touched on a routine edit, so collapsed by default. */}
          <div className="border-t border-hairline pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1.5 text-sm font-semibold text-ink-2 hover:text-ink"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              Advanced options
              {!showAdvanced && formData.notes && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              )}
            </button>
          </div>

          {showAdvanced && (<>
            {/* Job Type — Status moved out to a pill row at the top of the
                modal (audit: status was buried under Advanced). */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Job Type</label>
              <select
                value={formData.job_type}
                onChange={e => {
                  const v = e.target.value
                  setFormData(f => ({ ...f, job_type: v }))
                  if (isFieldChanged('job_type', v)) commitField({ job_type: v })
                }}
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base bg-panel"
              >
                {!['residential', 'deep_clean', 'commercial', 'str_turnover', 'one_time'].includes(formData.job_type) && (
                  <option value={formData.job_type}>{formData.job_type || '(unset)'}</option>
                )}
                <option value="residential">Residential</option>
                <option value="deep_clean">Deep Clean</option>
                <option value="commercial">Commercial</option>
                <option value="str_turnover">STR Turnover</option>
                <option value="one_time">One-time</option>
              </select>
            </div>

            {/* Pay override — only for turnovers, where piece-vs-hourly is a real
                choice (e.g. a weekend airbnb you'd rather pay hourly). */}
            {formData.job_type === 'str_turnover' && (
              <div>
                <label className="block text-sm font-semibold text-ink-2 mb-2">Pay</label>
                <select
                  value={formData.pay_mode}
                  onChange={e => {
                    const v = e.target.value
                    setFormData(f => ({ ...f, pay_mode: v }))
                    if (isFieldChanged('pay_mode', v)) commitField({ pay_mode: v })
                  }}
                  className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base bg-panel"
                >
                  <option value="auto">Auto — weekend = piece rate, weekday = hourly</option>
                  <option value="hourly">Hourly — pay by the hour even on a weekend</option>
                  <option value="piece">Piece rate — per-property turnover rate</option>
                </select>
                <p className="text-xs text-ink-3 mt-1">Native payroll only — overrides how this turnover is paid.</p>
              </div>
            )}

            {/* Hourly bump — the "+$1/hr" offer for a two-cleaner deep clean or a
                weekday immediate turnover. Applies to hourly pay on this job for
                every assigned cleaner; piece-rate pay ignores it. */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Hourly bump ($/hr)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={formData.pay_rate_bump}
                onChange={e => setFormData(f => ({ ...f, pay_rate_bump: e.target.value }))}
                onBlur={() => {
                  if (!isFieldChanged('pay_rate_bump', formData.pay_rate_bump)) return
                  const v = formData.pay_rate_bump === '' || formData.pay_rate_bump == null
                    ? null : Number(formData.pay_rate_bump) || 0
                  commitField({ pay_rate_bump: v })
                }}
                placeholder="0 — no bump"
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              />
              <p className="text-xs text-ink-3 mt-1">
                Extra dollars per hour on top of each cleaner's normal rate, for this job only —
                e.g. +$1/hr for a two-cleaner deep clean. Doesn't apply to piece-rate turnovers.
              </p>
            </div>

            {/* Address — editable; pre-fills from the property when blank */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-2">Address</label>
              <input
                type="text"
                value={formData.address}
                onChange={e => setFormData(f => ({ ...f, address: e.target.value }))}
                onBlur={() => { if (isFieldChanged('address', formData.address)) commitField({ address: formData.address }) }}
                placeholder="Service address (auto-fills from the property)"
                className="w-full px-3 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-semibold text-ink-2 mb-3">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                onBlur={() => { if (isFieldChanged('notes', formData.notes)) commitField({ notes: formData.notes }) }}
                placeholder="Add any notes about this job..."
                rows={3}
                className="w-full px-4 py-3 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none text-base"
              />
            </div>

            {/* Dispatch status */}
            {!isNew && (
              <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-panel px-3 py-2.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${job?.dispatched ? 'bg-emerald-500' : 'bg-ink-3'}`} aria-hidden="true" />
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">
                    {job?.dispatched ? 'Dispatched' : 'Not dispatched'}
                  </p>
                  <p className="text-xs text-ink-3">
                    {job?.dispatched ? 'This job has been sent to cleaners' : 'Job is ready to dispatch'}
                  </p>
                </div>
              </div>
            )}
          </>)}

          {error && (
            <div className="flex items-start gap-2.5 bg-panel border border-hairline text-ink-2 px-4 py-3 rounded-lg text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1.5" aria-hidden="true" />
              <span className="min-w-0">{error}</span>
            </div>
          )}

          {conflict && (
            <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-panel px-3 py-2.5 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-ink mb-1">Scheduling conflict</p>
                <p className="text-ink-2 mb-2">{conflict}</p>
                <button
                  onClick={() => {
                    // Existing-job per-field conflict: retry exactly the
                    // payload that 409'd, this time with allow_conflicts.
                    if (pendingRetry) { saveField(pendingRetry, true); return }
                    // Recurring endpoints (reschedule/split/resync) don't
                    // have a conflict-check pass to override — reopening the
                    // scope dialog is what the old global Save did here too.
                    if (isRecurring) { setScopeDialog('edit'); return }
                    // New-job creation conflict.
                    handleSave(true)
                  }}
                  disabled={saving}
                  className="w-full sm:w-auto px-3 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 disabled:opacity-60 text-xs font-medium transition-colors"
                >
                  {saving ? 'Saving…' : 'Save anyway (override conflict)'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-hairline bg-bg p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 sm:items-center sm:justify-between sticky bottom-0">
          {/* Destructive actions live on the left, away from Save (existing jobs only). */}
          {!isNew ? (
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={removing || saving}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              {formData.status !== 'cancelled' && (
                <button
                  onClick={handleCancelJob}
                  disabled={removing || saving}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-60 transition-colors"
                >
                  <Ban className="w-4 h-4" /> Cancel job
                </button>
              )}
            </div>
          ) : <span className="hidden sm:block" />}
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <Button variant="secondary" onClick={onClose} className="w-full sm:w-auto">
              Close
            </Button>
            {/* Existing jobs auto-save per field (see commitField/saveField) —
                there's nothing left for a global Save button to batch. Only
                a brand-new job, which has no id to PATCH against yet, still
                needs an explicit submit. */}
            {isNew && (
              <Button variant="primary" onClick={() => handleSave(false)} disabled={saving || removing} className="w-full sm:w-auto">
                {saving ? 'Saving...' : 'Create Job'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {scopeDialog && (
        <RecurrenceScopeDialog
          mode={scopeDialog}
          busy={saving || removing}
          fields={[...dirtySeriesFields].map(k => FIELD_LABELS[k]).filter(Boolean)}
          onChoose={handleScopeChoice}
          onCancel={() => setScopeDialog(null)}
        />
      )}
    </div>
  )
}
