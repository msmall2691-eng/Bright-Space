import { ArrowRight, CheckCircle2, Users, Zap } from 'lucide-react'
import { EmptyState, StatCard } from '../ui'
import { Tile, TileLoading } from './primitives'

/** "Turnover coverage" tile — STR cleanings this week and how many still
 *  need a crew. Two-up StatCards give total + need-a-cleaner counts. */
export function TurnoverCoverageTile({ loading, turnover, navigate }) {
  return (
    <Tile
      icon={Zap}
      iconColor="text-amber-500"
      title="Turnover coverage"
      badge={turnover.needCrew > 0 && (
        <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
          {turnover.needCrew} need a crew
        </span>
      )}
      action="Open schedule"
      onAction={() => navigate('/schedule')}
    >
      {loading ? (
        <TileLoading />
      ) : turnover.total === 0 ? (
        <EmptyState compact icon={CheckCircle2} title="No turnovers this week"
          description="STR cleanings will show here." />
      ) : (
        <div className="flex-1 grid grid-cols-2 gap-3">
          <StatCard label="Turnovers (7 days)" value={turnover.total} />
          <StatCard label="Need a cleaner"
            value={turnover.needCrew}
            accent={turnover.needCrew > 0 ? 'text-amber-600' : 'text-emerald-600'}
            onClick={() => navigate('/schedule')} />
        </div>
      )}
    </Tile>
  )
}

/** "Crew workload" tile — a per-cleaner 7-day booking count as a
 *  horizontal bar chart (relative to the busiest cleaner), plus a red
 *  "unassigned" callout row when jobs need a crew. When the (native)
 *  roster fetch fails, cleaners are shown by their ID and a small
 *  banner explains why. */
export function CrewWorkloadTile({ loading, crew, rosterUnavailable, navigate }) {
  return (
    <Tile
      icon={Users}
      iconColor="text-blue-500"
      title="Crew workload (7 days)"
      badge={crew.unassigned > 0 && (
        <span className="text-[10px] font-bold text-white bg-amber-500 px-1.5 py-0.5 rounded-full">
          {crew.unassigned} unassigned
        </span>
      )}
      action="Open schedule"
      onAction={() => navigate('/schedule')}
    >
      {loading ? (
        <TileLoading />
      ) : crew.rows.length === 0 && crew.unassigned === 0 ? (
        <EmptyState compact icon={Users} title="No jobs this week"
          description="Assignments will show here." />
      ) : (
        <div className="flex-1 overflow-y-auto max-h-[300px] space-y-1.5">
          {rosterUnavailable && (
            <p className="text-[11px] text-ink-3 bg-bg-2 rounded-lg px-2.5 py-1.5">
              Couldn’t load the crew roster — cleaners shown by ID.{' '}
              <button onClick={() => navigate('/crew')} className="underline hover:text-ink-2">
                Manage crew
              </button>
            </p>
          )}
          {crew.rows.map(r => {
            const pct = crew.rows[0] ? Math.round((r.n / crew.rows[0].n) * 100) : 0
            return (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <span className="w-28 truncate text-ink-2 shrink-0">{r.name}</span>
                <div className="flex-1 bg-bg-2 rounded-full h-2 overflow-hidden">
                  <div className="bg-blue-500 h-full rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-6 text-right font-semibold text-ink shrink-0">{r.n}</span>
              </div>
            )
          })}
          {crew.unassigned > 0 && (
            <button onClick={() => navigate('/schedule')}
              className="w-full flex items-center justify-between gap-2 border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2 text-sm text-amber-800 dark:text-amber-300 hover:opacity-90 transition-opacity mt-1">
              <span>Jobs with no crew assigned</span>
              <span className="font-bold flex items-center gap-1">{crew.unassigned} <ArrowRight className="w-3.5 h-3.5" /></span>
            </button>
          )}
        </div>
      )}
    </Tile>
  )
}
