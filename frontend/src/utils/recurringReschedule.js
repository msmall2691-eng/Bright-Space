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

  if (scope === 'future') {
    const payload = { cleaner_ids: cleanerIds, split_date: originalDate, start_time: newStart, end_time: newEnd }
    if (dateChanged) {
      const dow = isoDateToBackendDow(newDate)
      payload.days_of_week = [dow]
      payload.day_of_week = dow
    }
    await post(`/api/recurring/${schedId}/split`, payload)
    return { message: 'Moved this visit and every future one in the series' }
  }

  if (scope === 'all') {
    const payload = { cleaner_ids: cleanerIds, resync: true, start_time: newStart, end_time: newEnd }
    if (dateChanged) {
      const dow = isoDateToBackendDow(newDate)
      payload.days_of_week = [dow]
      payload.day_of_week = dow
    }
    const res = await patch(`/api/recurring/${schedId}`, payload)
    return { message: `Moved the whole series (${res?.resynced_jobs || 0} upcoming visit(s) re-synced)` }
  }

  throw new Error(`Unknown recurrence scope: ${scope}`)
}
