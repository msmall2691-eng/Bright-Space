import RecordLink from '../RecordLink'
import { formatDate } from '../../utils/format'
import { STATUS_DOT } from '../../theme/statusDots'

/**
 * "Nobody closed out Thursday's visit" — said on the thread, while you are
 * reading the message that asks about it.
 *
 * ## Why this exists
 *
 * The owner sent a screenshot of a customer writing *"Didn't know if
 * something got mixed up since no one came yesterday."* The app knew. A job
 * was on the calendar for that day and nothing ever moved it off `scheduled`.
 * That fact sat in the payload the thread had already fetched, and the only
 * place it surfaced was `ContactPanel`'s "Recent visits" — which, until the
 * same change that added this, drew a CHECKMARK next to it.
 *
 * So the operator reading "no one came yesterday" had to go and find out,
 * while the answer was one derived filter away.
 *
 * ## It links, it does not act
 *
 * `Job` is canonical (scheduling-invariants Rule 0) and the Schedule owns
 * resolving one of these. A "Mark complete" button here would make the inbox
 * a second writer of schedule state, which is the exact shape of the drift
 * that contract exists to prevent. This raises the question and points at the
 * screen that answers it.
 *
 * Renders nothing when there is nothing wrong — an always-present all-clear
 * trains people to skip the spot the real thing appears in.
 */
export function UnresolvedVisitNote({ visits = [] }) {
  if (!visits.length) return null
  const [first, ...rest] = visits
  const when = formatDate(first.scheduled_date, { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <div className="flex items-start gap-2 rounded-lg bg-panel border border-hairline px-3 py-2 text-[13px] text-ink-2">
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${STATUS_DOT.attention}`} aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="text-ink font-semibold">{when}</span>
        {"'s visit was never closed out"}
        {rest.length > 0 && `, and ${rest.length} earlier ${rest.length === 1 ? 'one' : 'ones'}`}
        {/* A sentence break rather than an em dash: in the thread column the
            line wraps, and a dash left stranded at the start of the second
            line reads as a typo. */}
        {'. '}
        <RecordLink type="job" id={first.id} label="Open it on the Schedule" className="text-[13px]" />
      </p>
    </div>
  )
}
