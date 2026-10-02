/**
 * "Needs a date" — open jobs with no scheduled_date, listed above the
 * calendar so they stop being invisible.
 *
 * Why this exists: accepting a quote auto-converts it to a job with NO date
 * (the owner picks the day afterwards). The week/month query is date-bounded,
 * so those jobs never appeared anywhere on the Schedule page — the
 * `visitsByDate.unscheduled` bucket was built for them but always empty.
 * The list rides the /api/schedule/week payload (`unscheduled`) — no extra
 * request, office roles only (crew never receive it).
 *
 * Design language: one hairline card, amber dot + plain words, each row a
 * record link to the job and a small secondary "Schedule" action that opens
 * the existing JobEditModal on that job. No pill labels, no tinted banner,
 * no count bubble — the count is a plain ink-3 number next to the words.
 * Renders nothing when there's nothing to say.
 */
import { Link } from 'react-router-dom'

const BTN =
  'shrink-0 px-2.5 py-1.5 rounded-md bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 text-xs font-medium transition-colors'

const SHOW = 4

export default function NeedsDateStrip({ jobs, onSchedule }) {
  const list = Array.isArray(jobs) ? jobs : []
  if (list.length === 0) return null
  const shown = list.slice(0, SHOW)
  const more = list.length - shown.length

  return (
    <div className="px-3 pt-1 pb-2" data-testid="needs-date-strip">
      <div className="rounded-lg border border-hairline bg-panel text-[12.5px]">
        <div className="flex items-center gap-2.5 px-3 pt-2 pb-1">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden="true" />
          <span className="font-medium text-ink">Needs a date</span>
          <span className="text-ink-3">{list.length}</span>
        </div>
        <ul className="divide-y divide-hairline">
          {shown.map(j => (
            <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 min-h-[40px]">
              <Link to={`/jobs/${j.id}`} className="font-medium text-ink hover:text-indigo-600 no-underline truncate">
                {j.client_name || j.title || `Job #${j.id}`}
              </Link>
              <span className="flex-1 min-w-0 truncate text-ink-3">
                {[j.property_name, j.quote_id ? 'from quote' : null].filter(Boolean).join(' · ')}
              </span>
              {onSchedule && (
                <button type="button" onClick={() => onSchedule(j)} className={BTN}
                  title="Pick a date and time for this job">
                  Schedule
                </button>
              )}
            </li>
          ))}
        </ul>
        {more > 0 && (
          <div className="px-3 py-1.5 text-[11px] text-ink-3">and {more} more</div>
        )}
      </div>
    </div>
  )
}
