import { Zap, Users, LogIn } from 'lucide-react'
import { shortDate } from './constants'

/** Small Google/Connecteam sync indicator chip. Three tones:
 *  - "ok" (green) — everything's on the target scheduler.
 *  - "partial" (amber) — some shifts pushed but at least one is missing
 *    (multi-cleaner job where a mid-dispatch Connecteam create failed;
 *    backend/integrations/connecteam_auto.py stores partial successes).
 *  - "off" (muted) — nothing pushed yet. */
export const SyncBadge = ({ state = 'off', label, okTitle, offTitle, partialTitle }) => {
  const cfg =
    state === 'ok' ? { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', mark: '✓', title: okTitle }
    : state === 'partial' ? { cls: 'bg-amber-50 text-amber-800 border-amber-200', mark: '◐', title: partialTitle || offTitle }
    : { cls: 'bg-bg-2 text-ink-3 border-hairline', mark: '○', title: offTitle }
  return (
    <span
      title={cfg.title}
      className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${cfg.cls}`}
    >
      {cfg.mark} {label}
    </span>
  )
}

/** Compute the sync state for a visit against its linked job (T-30).
 *
 *  Google: the gcal_event_id lives on Job, not on the derived Visit shape
 *  the /api/schedule/week endpoint emits — but _job_as_visit spreads the
 *  whole job dict, so v.gcal_event_id IS populated in practice. We check
 *  both to stay robust against any consumer that doesn't spread.
 *
 *  Connecteam: connecteam_shift_ids is a JSON array on Job. Comparing
 *  its length to the number of assigned cleaners gives us four states:
 *    - none:    no cleaner AND no shift → nothing to show (the "needs
 *      cleaner" queue owns this surface).
 *    - synced:  shifts >= expected. Includes the open-shift push path
 *      (Settings → Push open shifts writes shift_ids even with zero
 *      cleaners — Codex review #2 on #524).
 *    - partial: some shifts pushed but at least one is missing. This
 *      happens when auto_dispatch_job's mid-loop Connecteam create
 *      fails on one of several cleaners — the successful shift IDs are
 *      still persisted (Codex review #1 on #524).
 *    - missing: cleaners assigned but nothing pushed yet.
 */
export function computeVisitSyncState(visit, job) {
  const gcalOk = !!(visit?.gcal_event_id || job?.gcal_event_id)
  const rawIds = job?.connecteam_shift_ids
  const shifts = Array.isArray(rawIds) ? rawIds.length : 0
  const rawCleaners = visit?.cleaner_ids?.length ? visit.cleaner_ids : (job?.cleaner_ids || [])
  const cleaners = Array.isArray(rawCleaners) ? rawCleaners.length : 0
  const expected = cleaners
  let connecteamStatus = 'none'
  if (shifts === 0 && expected === 0) {
    connecteamStatus = 'none'
  } else if (shifts >= Math.max(expected, 1)) {
    connecteamStatus = 'synced'
  } else if (shifts > 0) {
    connecteamStatus = 'partial'
  } else {
    connecteamStatus = 'missing'
  }
  return { gcalOk, connecteamStatus, connecteamShifts: shifts, connecteamExpected: expected }
}

/** Per-visit sync chips (T-30). Shows Google + Connecteam status inline on
 *  the AgendaDay card so an operator can see which visits still need sync
 *  attention without opening each drawer. Compact enough to not clutter
 *  the card at density.
 *
 *  Connecteam chip hides only when there's no cleaner AND no shift — a
 *  legitimate "nothing to sync" state (the "needs cleaner" queue owns
 *  that surface). Push-as-open-shift (a shift with 0 cleaners assigned)
 *  still renders as synced so an owner can distinguish it from an
 *  un-pushed unassigned job. */
export function SyncStatusChips({ visit, job }) {
  const { gcalOk, connecteamStatus, connecteamShifts, connecteamExpected } =
    computeVisitSyncState(visit, job)
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <SyncBadge
        state={gcalOk ? 'ok' : 'off'}
        label="Google"
        okTitle="On Google Calendar"
        offTitle="Not yet on Google Calendar"
      />
      {connecteamStatus !== 'none' && (
        <SyncBadge
          state={connecteamStatus === 'synced' ? 'ok'
               : connecteamStatus === 'partial' ? 'partial'
               : 'off'}
          label="Connecteam"
          okTitle={connecteamExpected === 0
            ? "Pushed to Connecteam (open shift)"
            : "Pushed to Connecteam"}
          partialTitle={`Only ${connecteamShifts} of ${connecteamExpected} cleaners pushed to Connecteam`}
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
