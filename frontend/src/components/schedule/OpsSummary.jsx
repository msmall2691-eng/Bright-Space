/**
 * Ops summary — the "how does today look" answer that used to take a swipe
 * through a month grid. One quiet line of dot+word stats (the owner vetoed
 * the colored chip bubbles): values in ink, labels in ink-2, an amber dot
 * only where something actually needs attention (unassigned crew).
 *
 * Sits above AgendaDay; renders nothing when there are no jobs so the empty
 * state below can carry the day on its own.
 */

export default function OpsSummary({ stats, isToday }) {
  if (!stats || stats.jobs === 0) return null
  const items = [
    { key: 'jobs', value: stats.jobs, label: 'jobs' },
    { key: 'unassigned', value: stats.unassigned, label: 'need a crew', warn: stats.unassigned > 0 },
    { key: 'capacity', value: `${stats.capacityPct}%`, label: 'capacity' },
    { key: 'crews', value: stats.crewsOut, label: stats.crewsOut === 1 ? 'crew out' : 'crews out' },
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
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              )}
              <span className={`font-semibold tabular-nums ${c.warn ? 'text-amber-600 dark:text-amber-300' : 'text-ink'}`}>
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
