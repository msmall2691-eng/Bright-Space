import { Zap, Users, LogIn } from 'lucide-react'
import { shortDate } from './constants'

/** Small Google sync indicator — quiet dot + word, no tinted capsule.
 *  Sync-OK is a non-event, so it's nearly invisible (gray dot); only the
 *  not-synced state earns a colored (amber) dot. */
export const SyncBadge = ({ state = 'off', label, okTitle, offTitle }) => {
  const ok = state === 'ok'
  return (
    <span
      title={ok ? okTitle : offTitle}
      className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-3"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-ink-3/40' : 'bg-amber-400'}`} aria-hidden="true" />
      {label}
    </span>
  )
}

/** Compute the sync state for a visit against its linked job (T-30).
 *
 *  Google: the gcal_event_id lives on Job, not on the derived Visit shape
 *  the /api/schedule/week endpoint emits — but _job_as_visit spreads the
 *  whole job dict, so v.gcal_event_id IS populated in practice. We check
 *  both to stay robust against any consumer that doesn't spread.
 */
export function computeVisitSyncState(visit, job) {
  const gcalOk = !!(visit?.gcal_event_id || job?.gcal_event_id)
  return { gcalOk }
}

/** Per-visit sync chip (T-30). Shows Google Calendar status inline on the
 *  AgendaDay card so an operator can see which visits still need sync
 *  attention without opening each drawer. Compact enough to not clutter
 *  the card at density. */
export function SyncStatusChips({ visit, job }) {
  const { gcalOk } = computeVisitSyncState(visit, job)
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <SyncBadge
        state={gcalOk ? 'ok' : 'off'}
        label="Google"
        okTitle="On Google Calendar"
        offTitle="Not yet on Google Calendar"
      />
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
  // Same-day already gets its own (louder) badge below — this is the "not
  // same day, but still cutting it close" case the lead-time guardrail adds
  // (e.g. turnover ends 9pm, next guest checks in 8am — only 11h, but two
  // different calendar days so is_immediate_turnover alone would miss it).
  const tight = !immediate && job.turnover_lead_warning
  if (!booking && !next && !immediate && !tight) return null
  return (
    <div className={`flex items-center gap-2 flex-wrap ${compact ? 'mt-1' : 'mt-2'}`}>
      {immediate && (
        // Quiet dot+word — red text carries the urgency, no filled capsule.
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-red-600 dark:text-red-300"
          title="Next guest checks in today — same-day turnaround">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
          <Zap className="w-2.5 h-2.5" /> Immediate turnover
        </span>
      )}
      {tight && (
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300"
          title={`Only ~${Math.max(0, Math.round(job.turnover_lead_hours))}h before the next guest checks in`}>
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
          <Zap className="w-2.5 h-2.5" /> Tight turnaround
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
