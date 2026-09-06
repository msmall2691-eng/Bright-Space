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

import { isLiveSeries } from './recurringDuplicates'

/**
 * The bulk-able codes.
 *
 * Deliberately absent, and they should stay absent:
 *
 *   active_no_upcoming — the fix GENERATES visits. Doing that across a dozen
 *     series in one click puts a lot of real work on the calendar and on
 *     crew phones, and undoing it means deleting jobs (scheduling-invariants
 *     R7 forbids doing that automatically).
 *   duplicate — which twin survives differs per pair.
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
  // Cancelling is the one DESTRUCTIVE fix here, so it carries a guard the
  // others don't (see guardLastScheduleForClient) and is flagged danger.
  //
  // It earns its place because of what a real book looks like after a year:
  // every "this and all future visits" edit retires the old series and creates
  // a new one, so nearly every live client ends up with one working series and
  // a train of dead predecessors behind it. The owner's had 19. Clicking
  // Cancel nineteen times is the chore this exists to remove.
  stale_paused: {
    label: 'leftovers',
    verb: 'Cancel all',
    danger: true,
    method: 'delete',            // soft-cancel; PATCH is the default elsewhere
    body: () => null,
    preview: (issue) =>
      `${issue.title || 'Untitled'} · ${issue.client_name || 'unknown client'}`
      + (issue.cadence ? ` · ${issue.cadence}` : ''),
    tail: 'Past and completed visits are untouched, and each one can be resumed '
        + 'later from Manage.',
    guard: guardLastScheduleForClient,
  },
  // Paused COPIES of the same series. Distinct from stale_paused: that one is
  // a lone leftover, this is a pile of the same house, and the difference is
  // that here there is a keeper.
  //
  // The scan groups them (services/recurring_guards._group_paused_duplicates);
  // this reduces each group to "everything except the one worth keeping". That
  // reduction is what makes an otherwise per-series judgement bulk-able at
  // all — without it "cancel all" would cancel the keeper too.
  duplicate_paused: {
    label: 'duplicate copies',
    verb: 'Cancel the extra copies',
    danger: true,
    method: 'delete',
    body: () => null,
    preview: (issue) =>
      `${issue.title || 'Untitled'} · ${issue.client_name || 'unknown client'}`
      + (issue.cadence ? ` · ${issue.cadence}` : ''),
    tail: 'Where a series is still running, the paused copy goes and the running '
        + 'one carries on. Where every copy is paused, one is kept — the one with '
        + 'visits still on the calendar, or the most recent. History is untouched '
        + 'and each kept copy can still be resumed from Manage.',
    guard: keepOneCopyPerGroup,
  },
}

/**
 * Reduce each duplicate group to the copies that should go, holding back the
 * one to keep.
 *
 * Which one survives: the copy that still has visits on the calendar, because
 * cancelling that one would take real work off the schedule. Failing that, the
 * highest id — the most recently created, which is the one an "all future
 * visits" edit would have left as the working series.
 *
 * The keeper is HELD, not dropped, so the confirm names it. "I cancelled four
 * of these five" is only a decision somebody can make if they can see which
 * one stayed.
 */
export function keepOneCopyPerGroup(list) {
  const groups = new Map()
  const cancel = []
  const keep = []
  for (const issue of list) {
    const prob = (issue.problems || []).find(p => p.code === 'duplicate_paused')
    if (prob?.has_live_copy) {
      // A live series already covers this house and time, so there is no
      // "which do I keep" question — the running one is the keeper and this
      // paused copy goes. Holding one back here would mean the most common
      // shape (one live, one left behind) could never be batched at all.
      cancel.push(issue)
      continue
    }
    // The group's identity is its whole membership, sorted — every member
    // carries the same set, so any of them names the same bucket.
    const key = [issue.schedule_id, ...(prob?.partners || [])].sort((a, b) => a - b).join(',')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(issue)
  }
  for (const members of groups.values()) {
    const sorted = [...members].sort((a, b) => {
      const byVisits = (b.upcoming_job_count || 0) - (a.upcoming_job_count || 0)
      return byVisits !== 0 ? byVisits : b.schedule_id - a.schedule_id
    })
    keep.push(sorted[0])
    cancel.push(...sorted.slice(1))
  }
  return {
    list: cancel,
    held: keep,
    heldReason: 'it is the copy being kept',
  }
}

/**
 * Never bulk-cancel a client's ONLY schedule.
 *
 * A leftover whose client still has a live series is exactly that — a
 * leftover. One whose client has NOTHING live is that client's entire
 * recurring arrangement, and to the scan the two look identical: inactive,
 * nothing upcoming. Cancelling the second kind in a sweep would quietly end a
 * customer's cleans.
 *
 * That's a business decision, not tidying, so those are held back and named in
 * the confirm instead. The per-row Cancel link still handles them one at a
 * time, once the owner has decided.
 */
export function guardLastScheduleForClient(list, { schedules } = {}) {
  const clientsWithLiveSeries = new Set(
    (schedules || []).filter(isLiveSeries).map(s => String(s.client_id)))
  const safe = []
  const held = []
  for (const issue of list) {
    if (clientsWithLiveSeries.has(String(issue.client_id))) safe.push(issue)
    else held.push(issue)
  }
  return {
    list: safe,
    held,
    heldReason: 'it is the only schedule that client has left, so ending it is '
              + 'a decision about them, not tidying up',
  }
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
export function groupBulkable(issues, ctx = {}) {
  return Object.entries(BULK_FIXES)
    .map(([code, cfg]) => {
      const matched = (issues || []).filter(
        i => (i.problems || []).some(p => p.code === code))
      // A guard can hold rows back. Held rows are CARRIED, not dropped, so the
      // confirm can say what it is deliberately not doing.
      const guarded = cfg.guard ? cfg.guard(matched, ctx) : { list: matched, held: [] }
      return { code, cfg, ...guarded }
    })
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
export function describeBatch(cfg, list, shownMax = 8, held = [], heldReason = '') {
  const shown = list.slice(0, shownMax).map(cfg.preview)
  const rest = list.length - shown.length
  return `${cfg.verb} (${list.length} series):\n\n${shown.join('\n')}` +
    (rest > 0 ? `\n…and ${rest} more` : '') +
    // What is being SKIPPED matters as much as what isn't: a sweep that
    // silently left rows behind would send her hunting for them afterwards.
    (held.length
      ? `\n\nLeaving ${held.length} alone — ${heldReason}:\n`
        + held.slice(0, shownMax).map(cfg.preview).join('\n')
        + (held.length > shownMax ? `\n…and ${held.length - shownMax} more` : '')
      : '') +
    `\n\n${cfg.tail || 'History and completed visits are kept, and this can be undone one series at a time.'}`
}
