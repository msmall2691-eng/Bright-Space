import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { del, get, patch, post, put } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import { SERIES_STATE_LABEL, isLiveSeries, seriesState } from '../../utils/recurringDuplicates'
import Button from '../ui/Button'
import EmptyState from '../ui/EmptyState'
import ErrorNote from '../ui/ErrorNote'
import ListSkeleton from '../ui/ListSkeleton'
import EditSeriesModal from './EditSeriesModal'
import RescheduleModal from './RescheduleModal'
import SkipModal from './SkipModal'
import { computeUpcoming, endsSummary, fmtDate, fmtTime, ruleSummary } from './helpers'
import { ArrowLeft, Calendar, Clock, Pause, Pencil, Play, RefreshCw, SkipForward, Undo2 } from 'lucide-react'
import { SEV_DOT } from '../board/tokens'

export default function SeriesDetail({ id, onBack, onChanged, toast }) {
  const [schedule, setSchedule] = useState(null)
  const [exceptions, setExceptions] = useState([])
  const [client, setClient] = useState(null)
  const [generatedDates, setGeneratedDates] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // 'pause' | 'generate' | 'delete'
  const [modal, setModal] = useState(null) // { kind: 'skip'|'reschedule'|'edit', date, start, end }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [sch, exs, jobs] = await Promise.all([
        get(`/api/recurring/${id}`),
        get(`/api/recurring/${id}/exceptions`).catch(() => []),
        // Real materialized Jobs for this series — the rule projection below
        // (computeUpcoming) shows what SHOULD happen per the recurrence rule,
        // which can outrun what's actually been generated. Without this, the
        // detail page confidently listed dates that had no Job row yet, while
        // the series list's "N upcoming" (a real Job count) correctly said 0.
        get(`/api/jobs?recurring_schedule_id=${id}&status=scheduled&limit=200`).catch(() => []),
      ])
      setSchedule(sch)
      setExceptions(Array.isArray(exs) ? exs : [])
      setGeneratedDates(new Set(
        (Array.isArray(jobs) ? jobs : [])
          .map(j => (j.scheduled_date || '').slice(0, 10))
          .filter(Boolean)
      ))
      if (sch?.client_id) {
        const c = await get(`/api/clients/${sch.client_id}`).catch(() => null)
        setClient(c)
      }
    } catch (e) {
      setError(e.message || 'Failed to load recurring series')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const upcoming = useMemo(
    () => (schedule ? computeUpcoming(schedule, exceptions, 8) : []),
    [schedule, exceptions],
  )
  const generatedCount = upcoming.filter(u => generatedDates.has(u.date)).length

  const togglePause = async () => {
    if (!schedule) return
    setBusy('pause')
    try {
      await patch(`/api/recurring/${id}`, { active: !schedule.active })
      await load(); onChanged?.()
      toast.success(schedule.active ? 'Series paused' : 'Series resumed')
    } catch (e) {
      toast.error(e.message || 'Failed to update')
    } finally { setBusy('') }
  }
  const regenerate = async () => {
    setBusy('generate')
    try {
      const r = await post(`/api/recurring/${id}/generate`, {})
      await load(); onChanged?.()
      toast.success(`Materialized ${r.jobs_created || 0} new job${r.jobs_created === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error(e.message || 'Generation failed')
    } finally { setBusy('') }
  }
  const cancelSeries = async () => {
    // Visits already on the calendar for this series, from today on. Counted
    // from generatedDates (fetched with the page) rather than a fresh request:
    // these are real Job rows, and the answer only has to be right enough to
    // put a number in the question — the server reports what it actually
    // cancelled afterwards.
    const todayIso = new Date().toISOString().slice(0, 10)
    const booked = [...generatedDates].filter(d => d >= todayIso).length

    // Cancelling used to stop generation and leave every booked visit sitting
    // on the schedule — up to eight weeks of them — with the confirm text
    // explaining that she could go remove them one at a time. That reads as
    // "the button didn't work", and it's what she reported, twice.
    const answer = await confirmDialog(
      booked > 0
        ? `Cancel this recurring series?\n\nNo new visits will be generated.`
          + ` It still has ${booked} visit${booked === 1 ? '' : 's'} booked from today on.`
        : 'Cancel this recurring series?\n\nNo new visits will be generated.',
      {
        title: 'Cancel series',
        confirmLabel: booked > 0
          ? `Cancel series and its ${booked} visit${booked === 1 ? '' : 's'}`
          : 'Cancel series',
        // Only offered when there's something to keep. Someone does want this:
        // "stop the contract, but Thursday is still coming."
        altLabel: booked > 0 ? 'Keep the booked visits' : undefined,
        cancelLabel: 'Never mind',
        danger: true,
      },
    )
    if (!answer) return
    setBusy('delete')
    try {
      await del(`/api/recurring/${id}`)
      // Cancelling the visits is a SECOND call on purpose: the series is
      // already cancelled by the time this runs, so a failure here leaves her
      // with the thing she asked for plus an honest error, not a half-written
      // state she can't see.
      let removed = 0
      if (answer !== 'alt') {
        removed = (await post(`/api/recurring/${id}/cancel-upcoming`, {}))?.cancelled_count || 0
      }
      toast.success(removed > 0
        ? `Series cancelled — ${removed} booked visit${removed === 1 ? '' : 's'} taken off the schedule`
        : 'Series cancelled')
      onBack()
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Cancel failed')
      setBusy('')
    }
  }
  const undoException = async (ex) => {
    if (!(await confirmDialog(`Undo the ${ex.exception_type} on ${ex.exception_date}?`, { confirmLabel: 'Undo' }))) return
    try {
      await del(`/api/recurring/${id}/exceptions/${ex.id}`)
      await load(); onChanged?.()
      toast.success('Override removed')
    } catch (e) {
      toast.error(e.message || 'Undo failed')
    }
  }

  if (loading) return <div className="p-6"><ListSkeleton rows={4} /></div>
  if (error) return (
    <div className="p-6">
      <ErrorNote>{error}</ErrorNote>
      <Button variant="secondary" onClick={onBack} className="mt-4">Back to list</Button>
    </div>
  )
  if (!schedule) return null

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> All recurring series
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl sm:text-2xl font-bold text-ink">{schedule.title || 'Untitled'}</h1>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${isLiveSeries(schedule) ? '${SEV_DOT.good}' : 'bg-ink-3'}`} />
              {SERIES_STATE_LABEL[seriesState(schedule)]}
            </span>
          </div>
          <p className="text-sm text-ink-2">
            {client
              ? <Link to={`/clients/${client.id}`} className="hover:underline">{client.name}</Link>
              : schedule.client_id
                ? <Link to={`/clients/${schedule.client_id}`} className="hover:underline">{`Client #${schedule.client_id}`}</Link>
                : 'No client'}
            {' · '}{schedule.address}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={togglePause} disabled={busy === 'pause'}>
            {schedule.active
              ? <><Pause className="w-4 h-4 mr-1" />Pause</>
              : <><Play className="w-4 h-4 mr-1" />Resume</>}
          </Button>
          <Button variant="primary" size="sm" onClick={regenerate}
            disabled={!schedule.active || busy === 'generate'}>
            <RefreshCw className={`w-4 h-4 mr-1 ${busy === 'generate' ? 'animate-spin' : ''}`} />
            {busy === 'generate' ? 'Generating…' : 'Generate now'}
          </Button>
        </div>
      </div>

      {/* Rule summary + edit-future */}
      <div className="bg-panel border border-hairline rounded-lg p-4 mt-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-1">Recurring rule</div>
            <div className="text-[15px] text-ink font-medium">{ruleSummary(schedule)}</div>
            <div className="text-sm text-ink-2 mt-0.5">
              {fmtTime(schedule.start_time)} – {fmtTime(schedule.end_time)}
              {schedule.generate_weeks_ahead ? ` · generates ${schedule.generate_weeks_ahead} weeks ahead` : ''}
              {' · '}{endsSummary(schedule)}
            </div>
            {schedule.notes && <div className="text-[13px] text-ink-3 mt-2 italic">{schedule.notes}</div>}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'edit' })}>
            <Pencil className="w-4 h-4 mr-1" /> Edit rule (future visits)
          </Button>
        </div>
      </div>

      {/* Upcoming visits */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-ink">Upcoming visits</h2>
          <span className="text-xs text-ink-3">
            Skip or reschedule affects only that one visit
          </span>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState
            icon={Calendar}
            title="No upcoming visits"
            description={schedule.active
              ? 'Try widening the rule or generating jobs.'
              : 'Series is paused — no visits are being scheduled.'}
            compact
          />
        ) : (
          <>
            {generatedCount < upcoming.length && (
              <div className="mb-2 flex items-start gap-2 text-xs text-ink-2 bg-panel border border-hairline rounded-lg px-3 py-2">
                <span className={`w-1.5 h-1.5 rounded-full ${SEV_DOT.watch} shrink-0 mt-1`} aria-hidden="true" />
                <span>
                Only {generatedCount} of these {upcoming.length} dates {generatedCount === 1 ? 'has' : 'have'} an
                actual job on the Schedule — the rest are projected from the rule but haven't been generated yet.
                Use "Generate now" above to materialize them.
                </span>
              </div>
            )}
            <ul className="space-y-1.5">
            {upcoming.map((u) => (
              <li key={u.date}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border bg-panel border-hairline">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">
                    {fmtDate(u.date)}
                    {u.rescheduled && (
                      <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.watch}`} />
                        rescheduled
                      </span>
                    )}
                    {!generatedDates.has(u.date) && (
                      <span className="ml-2 inline-flex items-center gap-1.5 text-[10px] font-medium text-ink-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-ink-3/40 shrink-0" aria-hidden="true" />
                        not yet generated
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-3">
                    {fmtTime(u.start)} – {fmtTime(u.end)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="secondary" size="sm"
                    onClick={() => setModal({ kind: 'skip', date: u.date })}>
                    <SkipForward className="w-3.5 h-3.5 mr-1" /> Skip
                  </Button>
                  <Button variant="secondary" size="sm"
                    onClick={() => setModal({ kind: 'reschedule', date: u.date, start: u.start, end: u.end })}>
                    <Clock className="w-3.5 h-3.5 mr-1" /> Reschedule
                  </Button>
                </div>
              </li>
            ))}
            </ul>
          </>
        )}
      </div>

      {/* Exceptions log */}
      {exceptions.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-ink mb-2">Overrides history</h2>
          <ul className="space-y-1.5">
            {exceptions
              .slice()
              .sort((a, b) => (b.exception_date || '').localeCompare(a.exception_date || ''))
              .map((ex) => (
              <li key={ex.id}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-panel border border-hairline">
                <div className="min-w-0 text-sm">
                  <div>
                    <span className="font-semibold text-ink capitalize">{ex.exception_type}</span>
                    {' '}on{' '}
                    <span className="text-ink-2">{fmtDate(ex.exception_date)}</span>
                    {ex.exception_type === 'reschedule' && ex.rescheduled_date && (
                      <> → <span className="text-ink-2">{fmtDate(ex.rescheduled_date)}</span></>
                    )}
                  </div>
                  {ex.reason && <div className="text-xs text-ink-3 mt-0.5">{ex.reason}</div>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => undoException(ex)}>
                  <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Danger zone */}
      <div className="mt-8 pt-5 border-t border-hairline">
        <h2 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">Danger zone</h2>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-ink-3">
            Cancels the series so no new jobs are generated.
            Already-scheduled jobs remain on the calendar until you delete them individually.
          </p>
          <Button variant="secondary" size="sm" onClick={cancelSeries} disabled={busy === 'delete'}>
            Cancel series
          </Button>
        </div>
      </div>

      {modal?.kind === 'skip' && (
        <SkipModal
          schedule={schedule} date={modal.date}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Visit skipped') }}
        />
      )}
      {modal?.kind === 'reschedule' && (
        <RescheduleModal
          schedule={schedule} date={modal.date}
          defaultStart={modal.start} defaultEnd={modal.end}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Visit rescheduled') }}
        />
      )}
      {modal?.kind === 'edit' && (
        <EditSeriesModal
          schedule={schedule}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); onChanged?.(); toast.success('Rule updated for future visits') }}
        />
      )}
    </div>
  )
}
