import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { del, patch, post, put } from '../../api'
import { confirmDialog } from '../../utils/confirmBus'
import { SERIES_STATE_LABEL, groupDuplicateSeries, isLiveSeries, seriesState, suggestKeeper } from '../../utils/recurringDuplicates'
import { toast } from '../../utils/toastBus'
import Button from '../ui/Button'
import EmptyState from '../ui/EmptyState'
import ModalShell from './ModalShell'
import { computeUpcoming, fmtDate, fmtTime, ruleSummary } from './helpers'
import { Pause, Repeat } from 'lucide-react'
import { SEV_DOT } from '../board/tokens'
import { STATUS_TEXT } from '../../theme/statusText'

export default function DuplicateReviewPanel({ schedules, clientsById, reviewedKeys, onToggleReviewed, onChanged, onClose }) {
  // Snapshot group membership (and the keeper suggestion) at open, so acting
  // on a series doesn't make its group vanish mid-review — the group stays
  // put and collapses to a quiet "Resolved" row once one active series is
  // left. Cards still render LIVE data from the schedules prop.
  const [groups] = useState(() =>
    // Live series only, day sets matched by OVERLAP — the shared definition
    // in groupDuplicateSeries (ended split-predecessors never show up here).
    groupDuplicateSeries(schedules).map(g => ({
      key: g.key,
      ids: g.members.map(s => s.id),
      suggestion: suggestKeeper(g.members),
    })))
  const byId = useMemo(() => {
    const m = {}
    schedules.forEach(s => { m[s.id] = s })
    return m
  }, [schedules])
  const [keeperByKey, setKeeperByKey] = useState({}) // group key → chosen keeper id
  const [actioned, setActioned] = useState({})       // series id → 'paused' | 'cancelled'
  const [busyId, setBusyId] = useState(null)

  const doPause = async (s) => {
    const ok = await confirmDialog(
      `Pause “${s.title || 'Untitled'}”?\n\nNo new visits will be generated while it's paused; visits already on the calendar stay. You can resume it anytime from Manage.`,
      { title: 'Pause series', confirmLabel: 'Pause series' },
    )
    if (!ok) return
    setBusyId(s.id)
    try {
      await patch(`/api/recurring/${s.id}`, { active: false })
      setActioned(a => ({ ...a, [s.id]: 'paused' }))
      toast.success('Series paused')
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Failed to pause series')
    } finally { setBusyId(null) }
  }

  const doCancel = async (s) => {
    const n = s.upcoming_job_count || 0
    // Same choice as the detail page's cancel: the losing duplicate's booked
    // visits are exactly the ones cluttering the calendar, so offering to
    // leave them there was never the helpful default it looked like.
    const answer = await confirmDialog(
      `Cancel “${s.title || 'Untitled'}”?\n\nNo new visits will be generated for this series.`
      + (n > 0 ? ` It still has ${n} visit${n === 1 ? '' : 's'} booked.` : '')
      + ` Past and completed visits are untouched.`,
      {
        title: 'Cancel series',
        confirmLabel: n > 0 ? `Cancel series and its ${n} visit${n === 1 ? '' : 's'}` : 'Cancel series',
        altLabel: n > 0 ? 'Keep the booked visits' : undefined,
        cancelLabel: 'Never mind',
        danger: true,
      },
    )
    if (!answer) return
    setBusyId(s.id)
    try {
      await del(`/api/recurring/${s.id}`)
      let removed = 0
      if (answer !== 'alt') {
        removed = (await post(`/api/recurring/${s.id}/cancel-upcoming`, {}))?.cancelled_count || 0
      }
      setActioned(a => ({ ...a, [s.id]: 'cancelled' }))
      toast.success(removed > 0
        ? `Series cancelled — ${removed} booked visit${removed === 1 ? '' : 's'} taken off the schedule`
        : 'Series cancelled')
      onChanged?.()
    } catch (e) {
      toast.error(e.message || 'Failed to cancel series')
    } finally { setBusyId(null) }
  }

  return (
    <ModalShell title="Review duplicates" onClose={onClose} wide>
      <p className="text-[13px] text-ink-2">
        Each group below is the same client, property, cadence, and time on overlapping days. Pick the series to keep,
        then pause or cancel the extras — every action asks before it does anything, and
        visits already on the calendar are never touched.
      </p>
      {groups.length === 0 && (
        <EmptyState icon={Repeat} title="No duplicate groups"
          description="No two live series share a client, property, cadence, time, and day." compact />
      )}
      {groups.map(g => {
        const members = g.ids.map(id => byId[id]).filter(Boolean)
        const first = members[0]
        if (!first) return null
        const clientName = clientsById[first.client_id]?.name || 'Unknown client'
        const skipped = reviewedKeys.has(g.key)
        const activeMembers = members.filter(s => isLiveSeries(s) && !actioned[s.id])
        const keeperId = keeperByKey[g.key] ?? g.suggestion?.id

        if (skipped) {
          return (
            <div key={g.key}
              className="flex items-center gap-2 rounded-md border border-hairline bg-bg-2/50 px-3 py-2 text-[12px] text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-3 shrink-0" />
              <span className="min-w-0 truncate">
                Skipped — not duplicates · {clientName} · {ruleSummary(first)}
              </span>
              <button onClick={() => onToggleReviewed(g.key)}
                className="ml-auto shrink-0 font-medium text-ink-2 hover:text-ink underline underline-offset-2">
                Undo
              </button>
            </div>
          )
        }

        if (activeMembers.length <= 1) {
          const kept = activeMembers[0]
          return (
            <div key={g.key}
              className="flex items-center gap-2 rounded-md border border-hairline bg-bg-2/50 px-3 py-2 text-[12px] text-ink-3">
              <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.good} shrink-0`} />
              <span className="min-w-0 truncate">
                Resolved · {clientName} · {ruleSummary(first)}
                {kept ? <> — keeping “{kept.title || 'Untitled'}”</> : ' — no active series left'}
              </span>
            </div>
          )
        }

        return (
          <section key={g.key} className="rounded-md border border-hairline bg-bg-2/40 p-3">
            <header className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="text-sm font-semibold text-ink min-w-0">
                {clientName}
                <span className="font-normal text-ink-3"> · {ruleSummary(first)}</span>
              </div>
              <button onClick={() => onToggleReviewed(g.key)}
                className="shrink-0 text-[12px] text-ink-3 hover:text-ink underline underline-offset-2">
                Not duplicates — skip this group
              </button>
            </header>
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
              {members.map(s => {
                const state = actioned[s.id]
                  || seriesState(s)
                const isKeeper = state === 'active' && s.id === keeperId
                const suggested = g.suggestion?.id === s.id
                const next = state === 'active' ? computeUpcoming(s, [], 1)[0]?.date : null
                return (
                  <div key={s.id}
                    className={`rounded-md border bg-panel p-3 ${isKeeper ? 'border-emerald-300 dark:border-emerald-800' : 'border-hairline'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink truncate">{s.title || 'Untitled'}</div>
                        <div className="text-[12px] text-ink-2 truncate">
                          {s.client_id ? (
                            <Link to={`/clients/${s.client_id}`}
                              className="no-underline hover:text-link hover:underline">
                              {clientsById[s.client_id]?.name || `Client #${s.client_id}`}
                            </Link>
                          ) : 'No client'}
                          {' · '}{s.address}
                        </div>
                      </div>
                      {/* Bare dot + word. This was an `h-5` capsule with
                          `border border-hairline-2 bg-panel px-2` around a dot
                          and a word — the boxed "dot-pill" the design language
                          names as vetoed, in those exact classes. */}
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2 shrink-0">
                        <span className={`h-1.5 w-1.5 rounded-full ${
                          state === 'active' ? SEV_DOT.good
                          : state === 'cancelled' ? SEV_DOT.urgent : 'bg-ink-3'}`} />
                        {state === 'active' ? 'Active'
                          : state === 'cancelled' ? 'Cancelled'
                          : SERIES_STATE_LABEL[state] || 'Paused'}
                      </span>
                    </div>
                    <div className="mt-2 space-y-0.5 text-[12px] text-ink-3">
                      <div>{ruleSummary(s)} · {s.start_time
                        ? <>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</>
                        : <span className={`${STATUS_TEXT.attention} font-medium`}>no time set</span>}</div>
                      <div>Created {fmtDate((s.created_at || '').slice(0, 10)) || 'unknown'}</div>
                      <div>
                        {s.upcoming_job_count || 0} upcoming visit{(s.upcoming_job_count || 0) === 1 ? '' : 's'}
                        {next && <> · next {fmtDate(next)}</>}
                      </div>
                    </div>
                    {state === 'active' ? (
                      isKeeper ? (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex h-5 items-center gap-1.5 rounded-sm border border-emerald-300 dark:border-emerald-800 bg-panel px-2 text-[11px] font-medium ${STATUS_TEXT.ok} dark:text-emerald-400`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.good}`} />
                            Keeper
                          </span>
                          {suggested && (
                            <span className="text-[11px] text-ink-3">Suggested — {g.suggestion.reason}</span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <button onClick={() => setKeeperByKey(m => ({ ...m, [g.key]: s.id }))}
                            className="inline-flex items-center rounded-md border border-hairline bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 hover:text-ink">
                            Keep this one
                          </button>
                          <span className="ml-auto inline-flex items-center gap-2">
                            <Button variant="secondary" size="sm" disabled={busyId === s.id}
                              onClick={() => doPause(s)}>
                              <Pause className="w-3.5 h-3.5 mr-1" />Pause
                            </Button>
                            <button onClick={() => doCancel(s)} disabled={busyId === s.id}
                              className={`inline-flex items-center rounded-md border border-hairline bg-panel px-2.5 py-1.5 text-xs font-medium ${STATUS_TEXT.problem} hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed`}>
                              Cancel series
                            </button>
                          </span>
                        </div>
                      )
                    ) : (
                      <div className="mt-3 text-[11px] text-ink-3">
                        {state === 'cancelled'
                          ? 'Cancelled — no new visits will be generated.'
                          : state === 'ended'
                            ? 'Ended — this series reached its end date; no new visits are generated.'
                            : state === 'cancelled'
                              ? 'Cancelled — no new visits. Visits already on the calendar stay until you remove them.'
                              : 'Paused — no new visits while paused; resume anytime from Manage.'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
      <div className="flex justify-end pt-2">
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    </ModalShell>
  )
}

// ─── Detail view ─────────────────────────────────────────────────────────
