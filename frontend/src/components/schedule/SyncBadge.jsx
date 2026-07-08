import { Zap, Users, LogIn } from 'lucide-react'
import { shortDate } from './constants'

/** Small Google/Connecteam sync indicator chip. Green when synced, muted when
 *  not — the "is this on the working schedule / in staff scheduling?" signal. */
export const SyncBadge = ({ ok, label, okTitle, offTitle }) => (
  <span
    title={ok ? okTitle : offTitle}
    className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${
      ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-bg-2 text-ink-3 border-hairline'
    }`}
  >
    {ok ? '✓' : '○'} {label}
  </span>
)

/** Compute the sync state for a visit against its linked job (T-30).
 *
 *  Google: the gcal_event_id lives on Job, not on the derived Visit shape
 *  the /api/schedule/week endpoint emits — but _job_as_visit spreads the
 *  whole job dict, so v.gcal_event_id IS populated in practice. We check
 *  both to stay robust against any consumer that doesn't spread.
 *
 *  Connecteam: connecteam_shift_ids is a JSON array on Job — a non-empty
 *  array means at least one shift is live in the Connecteam scheduler
 *  (single-day jobs have 1, multi-day / multi-cleaner splits push more).
 *  Empty array + no assigned cleaner is a legitimate "nothing to push" —
 *  the counter and chip separate that from "assigned but not pushed" via
 *  the `hasCleaner` split.
 */
export function computeVisitSyncState(visit, job) {
  const gcalOk = !!(visit?.gcal_event_id || job?.gcal_event_id)
  const ctIds = job?.connecteam_shift_ids || []
  const connecteamOk = Array.isArray(ctIds) && ctIds.length > 0
  const hasCleaner = (visit?.cleaner_ids?.length || job?.cleaner_ids?.length || 0) > 0
  return { gcalOk, connecteamOk, hasCleaner }
}

/** Per-visit sync chips (T-30). Shows Google + Connecteam status inline on
 *  the AgendaDay card so an operator can see which visits still need sync
 *  attention without opening each drawer. Compact enough to not clutter
 *  the card at density.
 *
 *  Connecteam chip hides when no cleaner is assigned yet — a job with no
 *  cleaner can't be dispatched to Connecteam by design (the pusher skips
 *  it), so a "not synced" chip there would flag a state the operator has
 *  to fix by ASSIGNING first, not by pushing. The "needs cleaner" queue
 *  already covers that surface. */
export function SyncStatusChips({ visit, job }) {
  const { gcalOk, connecteamOk, hasCleaner } = computeVisitSyncState(visit, job)
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <SyncBadge
        ok={gcalOk}
        label="Google"
        okTitle="On Google Calendar"
        offTitle="Not yet on Google Calendar"
      />
      {hasCleaner && (
        <SyncBadge
          ok={connecteamOk}
          label="Connecteam"
          okTitle="Pushed to Connecteam"
          offTitle="Assigned but not yet in Connecteam"
        />
      )}
    </span>
  )
}

/** Airbnb/STR turnover context strip. The /api/jobs response enriches
 *  str_turnover jobs with `booking` (the reservation that just checked out),
 *  `next_arrival` (the next reservation), and `is_immediate_turnover` (next
 *  guest checks in the SAME day → clean fast). Surfacing this on the card is
 *  what makes the board actually useful for a turnover operation, instead of
 *  just a generic "Airbnb" tag. Renders nothing for non-turnover jobs. */
export const TurnoverInfo = ({ job, compact = false }) => {
  if (!job || job.job_type !== 'str_turnover') return null
  const booking = job.booking
  const next = job.next_arrival
  const immediate = job.is_immediate_turnover
  if (!booking && !next && !immediate) return null
  return (
    <div className={`flex items-center gap-2 flex-wrap ${compact ? 'mt-1' : 'mt-2'}`}>
      {immediate && (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700"
          title="Next guest checks in today — same-day turnaround">
          <Zap className="w-2.5 h-2.5" /> Immediate turnover
        </span>
      )}
      {booking?.guest_count > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-3" title="Guests who just checked out">
          <Users className="w-3 h-3" /> {booking.guest_count} guest{booking.guest_count === 1 ? '' : 's'}
        </span>
      )}
      {next?.checkin_date && (
        <span className={`inline-flex items-center gap-1 text-[11px] ${immediate ? 'text-red-600 font-semibold' : 'text-ink-3'}`}
          title="Next guest check-in">
          <LogIn className="w-3 h-3" /> Next: {shortDate(next.checkin_date)}
        </span>
      )}
    </div>
  )
}
