/**
 * Crew hand-off state — the "did the crew actually get told?" signal.
 *
 * BrightBase's crew-notification channel is Connecteam: dispatching a job
 * writes a shift per assigned cleaner (`job.connecteam_shift_ids`), and the
 * crew sees it in their Connecteam app. Until now that state was only shown
 * on the agenda card's tiny "sync" chip, framed as a technical sync detail —
 * so the operationally critical question ("has this crew been notified?")
 * was effectively invisible on the dispatch surfaces.
 *
 * This reuses the exact shift-vs-cleaner comparison the sync badge already
 * relies on (see computeVisitSyncState in SyncBadge.jsx), but re-frames it in
 * hand-off terms the dispatcher thinks in, and adds `canNotify` so the UI
 * knows when a "Send to crew" action is meaningful.
 *
 * States:
 *   - 'sent'    — every assigned cleaner has a shift. The crew has it.
 *   - 'partial' — some shifts exist but at least one cleaner is missing
 *                 (a mid-dispatch Connecteam failure left it half-pushed).
 *   - 'unsent'  — cleaners are assigned but nothing has been pushed yet.
 *   - 'na'      — nothing to hand off (no cleaner and no shift), or the
 *                 visit is cancelled/completed. No action to offer.
 */
export function computeDispatchState(job, visit) {
  const status = visit?.status || job?.status
  const terminal = status === 'cancelled' || status === 'completed'

  const rawIds = job?.connecteam_shift_ids
  const shifts = Array.isArray(rawIds) ? rawIds.length : 0
  const rawCleaners = visit?.cleaner_ids?.length ? visit.cleaner_ids : (job?.cleaner_ids || [])
  const expected = Array.isArray(rawCleaners) ? rawCleaners.length : 0

  let state
  if (expected === 0 && shifts === 0) state = 'na'
  else if (shifts >= Math.max(expected, 1)) state = 'sent'
  else if (shifts > 0) state = 'partial'
  else state = 'unsent'

  // A "Send to crew" action only makes sense when there's a crew to notify
  // and we're not fully sent already — and never on a finished/cancelled
  // visit. Re-sending an already-sent job is offered separately (re-sync).
  const canNotify = !terminal && expected > 0 && state !== 'sent'
  const canResend = !terminal && expected > 0 && state === 'sent'

  return { state, shifts, expected, canNotify, canResend, terminal }
}

/** Presentation for each hand-off state — label + chip classes + mark,
 *  kept beside the logic so the drawer and any future board chip render it
 *  identically. Flat Twenty-CRM chips; color reserved for status. */
export const DISPATCH_STATE_UI = {
  sent:    { label: 'Sent to crew',   mark: '✓', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/25' },
  partial: { label: 'Partly sent',    mark: '◐', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/25' },
  unsent:  { label: 'Not sent yet',   mark: '○', cls: 'bg-bg-2 text-ink-3 border-hairline' },
  na:      { label: 'Nothing to send', mark: '–', cls: 'bg-bg-2 text-ink-3 border-hairline' },
}
