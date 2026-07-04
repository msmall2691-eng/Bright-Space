import { AlertCircle, Clock, Calendar as CalendarIcon, Trash2 } from 'lucide-react'
import GlassCard from '../ui/GlassCard'
import StatCard from '../ui/StatCard'
import VisitCard from './VisitCard'

/** Three sub-sections of the Schedule page, all pure props-in:
 *  - ScheduleHealthStrip: today/this-week count cards + optional
 *    out-of-sync "Needs attention" strip.
 *  - ScheduleBulkBar: "Select all visible" checkbox + Clear + bulk cancel.
 *  - ScheduleListView: the week-grouped list branch (day headers + VisitCard
 *    rows), including the empty state. */

export function ScheduleHealthStrip({ stats }) {
  return (
    <div className="bg-bg border-b border-hairline px-3 sm:px-4 py-2.5">
      <div className="max-w-7xl mx-auto grid grid-cols-2 gap-2 sm:gap-3">
        <StatCard className="bg-panel border border-hairline rounded-lg" label="Today" value={stats.today} icon={CalendarIcon} />
        <StatCard className="bg-panel border border-hairline rounded-lg" label="This week" value={stats.week} icon={Clock} />
      </div>
      {(stats.notGcal > 0 || stats.notConnecteam > 0) && (
        <div className="max-w-7xl mx-auto mt-2 flex flex-wrap items-center gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium">Needs attention:</span>
          {stats.notGcal > 0 && <span>{stats.notGcal} not on Google yet</span>}
          {stats.notGcal > 0 && stats.notConnecteam > 0 && <span className="text-amber-300">·</span>}
          {stats.notConnecteam > 0 && <span>{stats.notConnecteam} not in Connecteam</span>}
        </div>
      )}
    </div>
  )
}

export function ScheduleBulkBar({
  visibleCount,
  allSelected,
  onSelectAllVisible,
  selectedCount,
  onClear,
  onBulkDelete,
  bulkDeleting,
}) {
  return (
    <div className="bg-panel border-b border-hairline px-4 py-2">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onSelectAllVisible}
            className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
            data-testid="visits-select-all"
          />
          <span>Select all visible ({visibleCount})</span>
        </label>
        {selectedCount > 0 && (
          <div className="flex items-center gap-2" data-testid="visits-bulk-actions">
            <span className="text-xs text-ink-2 font-medium">{selectedCount} selected</span>
            <button onClick={onClear}
              className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
              Clear
            </button>
            <button onClick={onBulkDelete} disabled={bulkDeleting}
              data-testid="visits-bulk-delete"
              className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
              {bulkDeleting ? 'Working...' : `Cancel ${selectedCount}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function ScheduleListView({
  visitsByDate,
  jobs,
  properties,
  clients,
  selectedVisitIds,
  onEdit,
  onDelete,
  onToggleSelect,
  empName,
}) {
  const entries = Object.entries(visitsByDate)
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-7xl mx-auto p-3 sm:p-4">
        {entries.length === 0 ? (
          <GlassCard>
            <div className="text-center py-12">
              <CalendarIcon className="w-12 h-12 text-ink-3 mx-auto mb-3" />
              <p className="text-ink-2">No visits scheduled for this week</p>
            </div>
          </GlassCard>
        ) : (
          <div className="space-y-4 sm:space-y-6">
            {entries
              .sort(([dateA], [dateB]) => {
                // "unscheduled" bucket sorts to the bottom.
                if (dateA === 'unscheduled') return 1
                if (dateB === 'unscheduled') return -1
                return dateA.localeCompare(dateB)
              })
              .map(([date, dateVisits]) => (
                <div key={date}>
                  <h2 className="text-base sm:text-lg font-bold text-ink mb-2 sm:mb-3">
                    {date === 'unscheduled'
                      ? `Unscheduled — pick a date in Edit Job (${dateVisits.length})`
                      : new Date(`${date}T00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                    }
                  </h2>
                  <div className="space-y-2 sm:space-y-3">
                    {dateVisits.map((visit) => (
                      <VisitCard
                        key={visit.id}
                        visit={visit}
                        job={jobs[visit.job_id]}
                        property={properties[jobs[visit.job_id]?.property_id]}
                        client={clients[jobs[visit.job_id]?.client_id]}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        selected={selectedVisitIds.has(visit.id)}
                        onToggleSelect={onToggleSelect}
                        empName={empName}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
