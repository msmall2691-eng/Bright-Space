/**
 * Recurring Doctor — which health-scan fixes are safe to apply in bulk, and
 * how to apply them.
 *
 * The scan routinely finds the SAME problem on a dozen series at once. A book
 * of 31 with five "already ended but still marked active" rows is the normal
 * shape, because an "all future visits" edit retires the old series by
 * end-date and leaves `active` True (see the recurring-doctor notes: that's a
 * known root cause, not a new bug). Fixing those one underlined link at a time
 * is the actual chore.
 *
 * This module lives outside the page so the decision about WHAT may be
 * batch-written to a live book of business is testable on its own, without
 * mounting a 1,500-line screen.
 */

/**
 * The bulk-able codes.
 *
 * Deliberately absent, and they should stay absent:
 *
 *   active_no_upcoming — the fix GENERATES visits. Doing that across a dozen
 *     series in one click puts a lot of real work on the calendar and on
 *     crew phones, and undoing it means deleting jobs (scheduling-invariants
 *     R7 forbids doing that automatically).
 *   stale_paused — cancelling is destructive; each one deserves its own look.
 *   duplicate / property_missing / no_property — the right answer differs per
 *     series (which twin survives, which property to relink to). There is no
 *     single fix to repeat.
 *
 * What's left are the two fixes that are identical across series and
 * reversible: flipping `active` off, and a rename computed from data already
 * on the row.
 */
export const BULK_FIXES = {
  ended_but_active: {
    label: 'ended',
    verb: 'Mark all as ended',
    // Same write the per-row link does, and just as reversible: `active`
    // flips back and no history is touched.
    body: () => ({ active: false }),
    preview: (issue) =>
      `${issue.title || 'Untitled'} · ${issue.client_name || 'unknown client'}`,
  },
  junk_title: {
    label: 'badly named',
    verb: 'Rename all',
    body: (issue) => ({ title: betterTitle(issue) }),
    preview: (issue) => `“${issue.title || '(blank)'}” → “${betterTitle(issue)}”`,
  },
}

/** "Client — Cadence", the same name the per-row rename produces. */
export function betterTitle(issue) {
  return issue.client_name ? `${issue.client_name} — ${issue.cadence}` : issue.cadence
}

/**
 * Group a scan's issues into bulk-able batches.
 *
 * Only returns a group when MORE THAN ONE series shares the problem — offering
 * "fix all (1)" next to a per-row link for the same series is just two buttons
 * that do the same thing.
 */
export function groupBulkable(issues) {
  return Object.entries(BULK_FIXES)
    .map(([code, cfg]) => ({
      code,
      cfg,
      list: (issues || []).filter(i => (i.problems || []).some(p => p.code === code)),
    }))
    .filter(g => g.list.length > 1)
}

/**
 * Apply a fix across a batch, one at a time.
 *
 * Sequential on purpose, not Promise.all: this runs against one small
 * container, and firing a dozen writes at it simultaneously is how a cleanup
 * turns into an outage. One failure doesn't stop the rest — a half-finished
 * batch is fine here (each write is independent), but the caller must be told
 * exactly which ones didn't make it.
 */
export async function applyBatch(list, apply) {
  let done = 0
  const failed = []
  for (const issue of list) {
    try {
      await apply(issue)
      done += 1
    } catch {
      failed.push(issue.title || `#${issue.schedule_id}`)
    }
  }
  return { done, failed }
}

/**
 * The confirm text: every series named, up to a limit, before anything is
 * written. The recurring-doctor rule is that a bulk fix proposes the exact
 * list and waits — a count alone ("fix 12 series?") isn't a decision anyone
 * can actually make.
 */
export function describeBatch(cfg, list, shownMax = 8) {
  const shown = list.slice(0, shownMax).map(cfg.preview)
  const rest = list.length - shown.length
  return `${cfg.verb} (${list.length} series):\n\n${shown.join('\n')}` +
    (rest > 0 ? `\n…and ${rest} more` : '') +
    '\n\nHistory and completed visits are kept, and this can be undone one series at a time.'
}
