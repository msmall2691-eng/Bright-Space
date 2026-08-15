import { Calendar } from 'lucide-react'
import { EmptyState } from '../ui'
import { Tile, TileLoading } from './primitives'

/** "Today's schedule" tile — jobs scheduled for today with time, title,
 *  and address. Tapping a row jumps to the job detail. Empty state
 *  mentions the "later this week" job count so the operator knows the
 *  week isn't necessarily empty. */
export function TodayTile({ loading, todayJobs, todayCount, weekCount, navigate }) {
  return (
    <Tile
      icon={Calendar}
      iconColor="text-violet-500"
      title="Today's schedule"
      badge={todayCount > 0 && (
        <span className="text-[10px] font-semibold text-ink-3 tabular-nums">
          {todayCount}
        </span>
      )}
      action="Open Schedule"
      onAction={() => navigate('/schedule')}
    >
      {loading ? (
        <TileLoading />
      ) : todayJobs.length === 0 ? (
        <EmptyState compact icon={Calendar} title="Nothing scheduled today"
          description={weekCount > 0 ? `${weekCount} jobs later this week` : undefined} />
      ) : (
        <div className="flex-1 overflow-y-auto max-h-[380px]">
          {todayJobs.map(j => (
            <button
              key={j.id}
              onClick={() => navigate(`/jobs/${j.id}`)}
              className="w-full text-left flex items-baseline gap-3 px-5 py-3 hover:bg-bg active:bg-bg-2 transition-colors border-b border-hairline last:border-b-0"
            >
              <span className="text-[12px] font-semibold text-indigo-600 tabular-nums shrink-0 w-12">
                {(j.start_time || '').slice(0, 5) || '—'}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] text-ink truncate">{j.title}</span>
                {j.address && (
                  <span className="block text-[11px] text-ink-3 truncate mt-0.5">{j.address}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </Tile>
  )
}
