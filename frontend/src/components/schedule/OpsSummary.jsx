/**
 * Ops summary — the "how does today look" answer that used to take a swipe
 * through a month grid. One quiet line of dot+word stats (the owner vetoed
 * the colored chip bubbles): values in ink, labels in ink-2, an amber dot
 * only where something actually needs attention (unassigned crew).
 *
 * Sits above AgendaDay; renders nothing when there are no jobs so the empty
 * state below can carry the day on its own.
 */

import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'
export default function OpsSummary({ stats, isToday, compact = false }) {
  if (!stats || stats.jobs === 0) return null
  // `compact` (the phone/agenda hero) shows only the one plain fact — how many
  // jobs today. The "need a crew" count used to live here too, but OpsAlerts
  // sits directly below in the same hero and already names that number WITH the
  // actions on it (Assign / Open to crew), so printing it here as well was a
  // duplicate number (ui-revamp: merge duplicate numbers) that also read "0
  // need a crew" on a calm day — empty furniture. capacity% and crews-out stay
  // desktop-DayBoard context only; on a phone they turned this into a stat row
  // (owner: "way too busy").
  const items = [
    { key: 'jobs', value: stats.jobs, label: 'jobs' },
    ...(compact ? [] : [
      { key: 'unassigned', value: stats.unassigned, label: 'need a crew', warn: stats.unassigned > 0 },
      { key: 'capacity', value: `${stats.capacityPct}%`, label: 'capacity' },
      { key: 'crews', value: stats.crewsOut, label: stats.crewsOut === 1 ? 'crew out' : 'crews out' },
    ]),
  ]
  return (
    <div className="px-4 pt-1 pb-3">
      {isToday && (
        <div className="text-[10px] font-mono tracking-widest uppercase text-ink-3 mb-1">
          Today at a glance
        </div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-ink-2">
        {items.map((c, i) => (
          <span key={c.key} className="inline-flex items-baseline gap-x-2 whitespace-nowrap">
            {i > 0 && <span className="text-ink-3/50" aria-hidden>·</span>}
            <span className="inline-flex items-center gap-1.5">
              {c.warn && (
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT.attention} shrink-0`} aria-hidden="true" />
              )}
              <span className={`font-semibold tabular-nums ${c.warn ? STATUS_TEXT.attention : 'text-ink'}`}>
                {c.value}
              </span>
              <span className="text-ink-3">{c.label}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
