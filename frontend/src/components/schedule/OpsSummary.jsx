/**
 * Ops summary chip strip — the "how does today look" answer that used to
 * take a swipe through a month grid. Four numbers, tabular monospace, warn
 * variant when there's work waiting on a decision (unassigned crew).
 *
 * Sits above AgendaDay; renders nothing when there are no jobs so the empty
 * state below can carry the day on its own.
 */

export default function OpsSummary({ stats, isToday }) {
  if (!stats || stats.jobs === 0) return null
  const chips = [
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
      <div className="flex flex-wrap gap-1.5">
        {chips.map(c => (
          <span
            key={c.key}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11.5px] font-mono tabular-nums ${
              c.warn
                ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-bg-2 border-hairline text-ink-3'
            }`}
          >
            <strong className={`text-[12.5px] font-semibold ${c.warn ? 'text-amber-700' : 'text-ink'}`}>
              {c.value}
            </strong>
            <span>{c.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
