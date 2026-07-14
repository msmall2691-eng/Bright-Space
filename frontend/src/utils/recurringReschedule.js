import { post, patch } from '../api'

/** JS Date.getDay() is 0=Sun..6=Sat; the backend's day_of_week is 0=Mon..6=Sun
 *  (matches Python's date.weekday()). Parses as local midnight, not UTC, so a
 *  "YYYY-MM-DD" string doesn't shift a day depending on the caller's timezone. */
export function isoDateToBackendDow(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`)
  return (d.getDay() + 6) % 7
}

/**
 * Reschedule ONE occurrence of a recurring job to a new date/time, per the
 * chosen Jobber-parity scope (see RecurrenceScopeDialog). Shared by
 * JobEditModal's save flow and the calendar's drag-to-reschedule so both
 * routes to the same series-consistent mechanism instead of a bare PATCH —
 * see RecurrenceScopeDialog's header comment for why that's unsafe for a
 * recurring job.
 *
 * This is deliberately date/time-only (no title/status/crew carry-through)
 * since a drag can only ever change when a visit happens, not what it is —
 * JobEditModal's own performRecurringSave layers its form-field carry-through
 * on top of the same three endpoints for its richer edit case.
 */
export async function rescheduleRecurringVisit(scope, {
  schedId, originalDate, newDate, newStart, newEnd, cleanerIds,
}) {
  const dateChanged = newDate !== originalDate

  if (scope === 'this') {
    const res = await post(`/api/recurring/${schedId}/reschedule`, {
      exception_date: originalDate,
      rescheduled_date: newDate,
      rescheduled_start_time: newStart,
      rescheduled_end_time: newEnd,
      cleaner_ids: cleanerIds,
      reason: 'Rescheduled by drag on the calendar',
    })
    return { message: 'Moved this visit only — the rest of the series is unchanged', jobId: res?.job_id }
  }

  // Fields describing the new day, applied to both 'future' and 'all' below.
  // days_of_week/day_of_week drive weekly/daily frequencies; day_of_month
  // drives monthly ones (generate_dates reads whichever field matches the
  // schedule's own frequency and ignores the other — see
  // modules/recurring/router.py). Sending both unconditionally means this
  // works correctly regardless of the schedule's frequency without the
  // caller needing to know it.
  const dayFields = {}
  if (dateChanged) {
    const dow = isoDateToBackendDow(newDate)
    dayFields.days_of_week = [dow]
    dayFields.day_of_week = dow
    dayFields.day_of_month = new Date(`${newDate}T00:00:00`).getDate()
  }

  if (scope === 'future') {
    // split_date becomes BOTH the old schedule's cutoff (it stops
    // generating on/after this date) and the new schedule's floor (it only
    // generates on/after this date) — see modules/recurring/router.py's
    // split_schedule. Anchoring it on originalDate alone breaks when the
    // visit moved EARLIER (e.g. dragged from Wednesday to the same week's
    // Monday): the new schedule's floor would then exclude the target
    // Monday, and that occurrence would vanish for a full cycle. Using
    // whichever date is earlier keeps both the old occurrence's cleanup and
    // the new occurrence's generation on the correct side of the boundary.
    const splitDate = originalDate < newDate ? originalDate : newDate
    await post(`/api/recurring/${schedId}/split`, {
      cleaner_ids: cleanerIds, split_date: splitDate,
      start_time: newStart, end_time: newEnd,
      ...dayFields,
    })
    return { message: 'Moved this visit and every future one in the series' }
  }

  if (scope === 'all') {
    const res = await patch(`/api/recurring/${schedId}`, {
      cleaner_ids: cleanerIds, resync: true,
      start_time: newStart, end_time: newEnd,
      ...dayFields,
    })
    return { message: `Moved the whole series (${res?.resynced_jobs || 0} upcoming visit(s) re-synced)` }
  }

  throw new Error(`Unknown recurrence scope: ${scope}`)
}
