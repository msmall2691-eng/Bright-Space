import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { del, get, patch, post } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import { applyBatch, describeBatch, groupBulkable } from '../../utils/recurringBulk'
import { toast } from '../../utils/toastBus'
import EmptyState from '../ui/EmptyState'
import ErrorNote from '../ui/ErrorNote'
import ModalShell from './ModalShell'
import { SEVERITY_DOT } from './helpers'
import { Repeat } from 'lucide-react'
import { STATUS_TEXT } from '../../theme/statusText'

/**
 * Recurring Doctor: the health-scan panel. Renders
 * GET /api/recurring/cleanup/health (a read-only server audit) and offers the
 * one-tap fix per problem code. Every fix goes through the normal endpoints
 * and asks first; destructive ones get the danger confirm.
 */
export default function HealthPanel({ onClose, onChanged, onOpenSeries, onOpenDuplicates, onCleanupOffPhase, cleaningOffPhase, schedules }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  const scan = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const next = await get('/api/recurring/cleanup/health')
      setReport(next)
      return next
    } catch (e) {
      setError(e.message || 'Health scan failed')
      return null
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { scan() }, [scan])

  const act = async (issue, fn, doneMsg) => {
    setBusyId(issue.schedule_id)
    try {
      await fn()
      if (doneMsg) toast.success(doneMsg)
      onChanged?.()
      await scan()
    } catch (e) {
      toast.error(e.message || 'That fix failed')
    } finally {
      setBusyId(null)
    }
  }

  // One primary fix per problem code (the scan's `suggestion` is the label's
  // tooltip). Rename is computed here from client + cadence rather than parsed
  // out of the suggestion string.
  const fixFor = (issue, prob) => {
    const id = issue.schedule_id
    switch (prob.code) {
      case 'junk_title': {
        const better = issue.client_name ? `${issue.client_name} — ${issue.cadence}` : issue.cadence
        return { short: `Rename to “${better}”`, run: () => act(issue, async () => {
          await patch(`/api/recurring/${id}`, { title: better })
        }, 'Renamed') }
      }
      case 'ended_but_active':
        return { short: 'Mark ended', run: () => act(issue, async () => {
          await patch(`/api/recurring/${id}`, { active: false })
        }, 'Marked ended — history kept') }
      // The series is already closed, so nothing regenerates and there is no
      // "which copy do I keep" question — but it still cancels real Jobs, so
      // it gets the danger confirm and stays out of the batch fixes.
      case 'cancelled_with_upcoming': {
        const n = prob.stranded ?? issue.upcoming_job_count ?? 0
        const noun = n === 1 ? 'visit' : 'visits'
        return { short: `Remove ${n} ${noun}`, danger: true, run: async () => {
          const ok = await confirmDialog(
            `Take ${n === 1 ? 'the 1 remaining visit' : `all ${n} remaining visits`} for `
            + `“${issue.title || 'Untitled'}” (${issue.client_name || 'this client'}) `
            + 'off the calendar? The series is already closed, so nothing will regenerate. '
            + 'Completed visits and history are kept.',
            { title: 'Remove these visits?', confirmLabel: `Remove ${n} ${noun}`, danger: true },
          )
          if (!ok) return
          act(issue, async () => {
            const r = await post(`/api/recurring/${id}/cancel-upcoming`)
            toast.success(`Removed ${r?.cancelled_count ?? n} ${noun} from the calendar`)
          })
        } }
      }
      // Linking IS the fix, not tidying: with no property the series can't
      // insert a Job at all (property_id is NOT NULL), so it has been silently
      // dead. Generate straight after, or she'd link it and still see nothing.
      case 'no_property':
        if (prob.suggest_property_id) {
          return { short: `Link to ${prob.suggest_property_label}`, run: () => act(issue, async () => {
            await patch(`/api/recurring/${id}`, { property_id: prob.suggest_property_id })
            const r = await post(`/api/recurring/${id}/generate`)
            const n = r?.created ?? r?.generated ?? 0
            toast.success(n ? `Linked — ${n} visits generated` : 'Linked to the property')
          }) }
        }
        // Two houses on the client: the scan withholds the suggestion rather
        // than guess which one, so this falls back to opening the series.
        return { short: 'Open series', run: () => { onClose(); onOpenSeries(id) } }
      // Cancels a real series AND takes its booked visits off the calendar, so
      // it names both in the confirm and never runs without one.
      case 'reschedule_leftover':
        return { short: 'Cancel the old one', danger: true, run: async () => {
          const n = issue.upcoming_job_count || 0
          const ok = await confirmDialog(
            `Cancel “${issue.title || 'Untitled'}” for `
            + `${issue.client_name || 'this client'}?\n\n${prob.message}\n\n`
            + (n ? `Its ${n} booked ${n === 1 ? 'visit comes' : 'visits come'} off the calendar too. ` : '')
            + 'The running series carries on. History is kept, and this cannot be resumed.',
            { title: 'Cancel the old series?', confirmLabel: 'Cancel series', danger: true },
          )
          if (!ok) return
          act(issue, async () => {
            await del(`/api/recurring/${id}`)
            const r = await post(`/api/recurring/${id}/cancel-upcoming`)
            const c = r?.cancelled_count || 0
            toast.success(c
              ? `Cancelled — ${c} booked ${c === 1 ? 'visit' : 'visits'} removed`
              : 'Series cancelled')
          })
        } }
      case 'active_no_upcoming':
        return { short: 'Generate visits', run: () => act(issue, async () => {
          const r = await post(`/api/recurring/${id}/generate`)
          toast.success(`Generated ${r?.created ?? r?.generated ?? ''} visits`.replace('  ', ' '))
        }) }
      case 'stale_paused':
        return { short: 'Cancel series', danger: true, run: async () => {
          const ok = await confirmDialog(
            `Cancel “${issue.title || 'Untitled'}” for ${issue.client_name || 'this client'}? ` +
            'It disappears from this list; completed visits and history are kept. It cannot be resumed.',
            { title: 'Cancel series?', confirmLabel: 'Cancel series', danger: true },
          )
          if (!ok) return
          act(issue, () => del(`/api/recurring/${id}`), 'Series cancelled')
        } }
      case 'duplicate':
        return { short: 'Review duplicates', run: () => { onClose(); onOpenDuplicates() } }
      case 'duplicate_paused':
        // Per-row it's the same act as cancelling a leftover — the difference
        // is only that the scan can now tell you it isn't a lone one. The
        // batch version ("Cancel the extra copies") keeps one per group.
        return { short: 'Cancel this copy', danger: true, run: async () => {
          const n = prob.partners?.length ?? 0
          const context = prob.has_live_copy
            ? 'A running series already covers this house and time — that one carries on.'
            : `There ${n === 1 ? 'is 1 other paused copy' : `are ${n} other paused copies`} of it.`
          const ok = await confirmDialog(
            `Cancel this copy of “${issue.title || 'Untitled'}” for `
            + `${issue.client_name || 'this client'}? ${context} `
            + 'History is kept and this cannot be resumed.',
            { title: 'Cancel this copy?', confirmLabel: 'Cancel copy', danger: true },
          )
          if (!ok) return
          act(issue, () => del(`/api/recurring/${id}`), 'Copy cancelled')
        } }
      default:
        return { short: 'Open series', run: () => { onClose(); onOpenSeries(id) } }
    }
  }

  // ── Fix-all, for the codes where the fix is identical and reversible ──────
  // Which codes qualify, and why the dangerous ones don't, lives in
  // utils/recurringBulk.js — that decision is about writing to a live book of
  // business, so it's tested on its own rather than buried in this screen.
  const [bulkBusy, setBulkBusy] = useState(null)
  const groups = groupBulkable(report?.issues, { schedules })

  const runBulk = async ({ code, cfg, list, held, heldReason }) => {
    const ok = await confirmDialog(describeBatch(cfg, list, 8, held, heldReason), {
      title: `${cfg.verb}?`, confirmLabel: `${cfg.verb} (${list.length})`,
      cancelLabel: 'Never mind', danger: !!cfg.danger,
    })
    if (!ok) return

    setBulkBusy(code)
    const before = report.issues.length
    // DELETE is the soft-cancel path (services: sets active=false and stamps
    // cancelled_at); everything else edits fields, so PATCH is the default.
    const { done, failed } = await applyBatch(list, (issue) =>
      cfg.method === 'delete'
        ? del(`/api/recurring/${issue.schedule_id}`)
        : patch(`/api/recurring/${issue.schedule_id}`, cfg.body(issue)))
    setBulkBusy(null)

    onChanged?.()
    const after = await scan()
    if (failed.length) {
      toast.error(`Fixed ${done} of ${list.length} — ${failed.length} failed: ${failed.slice(0, 3).join(', ')}`)
    } else {
      // Before/after: "12 fixed" means nothing without the remainder.
      toast.success(
        `Fixed ${done} · ${before} series needed attention, ${after?.issues?.length ?? '?'} still do`)
    }
  }

  return (
    <ModalShell title="Recurring health check" onClose={onClose} wide>
      {loading ? (
        <div className="text-center text-ink-3 py-10 text-sm">Scanning every series…</div>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-[13px] text-ink-2 flex-1 min-w-0">
              Scanned <b className="text-ink">{report.scanned}</b> series —{' '}
              <b className="text-ink">{report.healthy}</b> healthy,{' '}
              <b className="text-ink">{report.issues.length}</b> need{report.issues.length === 1 ? 's' : ''} attention.
              Nothing below changes without your confirm.
            </p>
            {onCleanupOffPhase && (
              <button
                onClick={onCleanupOffPhase}
                disabled={cleaningOffPhase}
                title="Separately check for off-cadence duplicate VISITS left by the old biweekly-drift bug — a different check from the schedule-level duplicates above"
                className="shrink-0 text-[12px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink-2 disabled:opacity-50">
                {cleaningOffPhase ? 'Checking off-cadence visits…' : 'Also check off-cadence visits'}
              </button>
            )}
          </div>
          {groups.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-hairline bg-bg-2/40 px-3 py-2">
              <span className="text-[12px] text-ink-3">Same fix, several series:</span>
              {groups.map(g => (
                <button key={g.code} onClick={() => runBulk(g)}
                  disabled={!!bulkBusy}
                  data-testid={`bulk-${g.code}`}
                  className="text-[12px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-50">
                  {bulkBusy === g.code
                    ? `Fixing ${g.list.length}…`
                    : `${g.cfg.verb} (${g.list.length} ${g.cfg.label})`}
                </button>
              ))}
            </div>
          )}

          {report.issues.length === 0 && (
            <EmptyState icon={Repeat} title="All series healthy"
              description="No duplicates, ghosts, or broken links found." compact />
          )}
          {report.issues.map(issue => (
            <section key={issue.schedule_id} className="rounded-md border border-hairline bg-bg-2/40 p-3">
              <header className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="text-sm font-semibold text-ink min-w-0 truncate">
                  {issue.title || 'Untitled'}
                  <span className="font-normal text-ink-3"> · {issue.client_name || 'Unknown client'} · {issue.cadence}</span>
                </div>
                <span className="shrink-0 text-[12px] text-ink-3">
                  {issue.upcoming_job_count} upcoming
                </span>
              </header>
              <ul className="mt-2 space-y-1.5">
                {issue.problems.map(prob => {
                  const fix = fixFor(issue, prob)
                  return (
                    <li key={prob.code} className="flex items-start gap-2 text-[13px] text-ink-2">
                      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[prob.severity] || 'bg-ink-3'}`} />
                      <span className="min-w-0 flex-1" title={prob.suggestion}>{prob.message}</span>
                      <button
                        onClick={fix.run}
                        disabled={busyId === issue.schedule_id}
                        className={`shrink-0 text-[12px] font-medium underline underline-offset-2 disabled:opacity-50 ${
                          fix.danger ? `${STATUS_TEXT.problem} hover:text-red-700` : 'text-ink-2 hover:text-ink'
                        }`}>
                        {fix.short}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </ModalShell>
  )
}
