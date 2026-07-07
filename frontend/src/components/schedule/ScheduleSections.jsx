import { AlertCircle, Clock, Calendar as CalendarIcon, Trash2 } from 'lucide-react'
import StatCard from '../ui/StatCard'

/** Two sub-sections of the Schedule page, all pure props-in:
 *  - ScheduleHealthStrip: today/this-week count cards + optional
 *    out-of-sync "Needs attention" strip.
 *  - ScheduleBulkBar: "Select all visible" checkbox + Clear + bulk cancel.
 *
 *  ScheduleListView + its VisitCard were removed when the time-grid Week
 *  view superseded the old grouped-list week view — the branch was already
 *  unreachable (VALID_VIEWS = ['agenda', 'week', 'month']) and the audit
 *  called it out. */

export function ScheduleHealthStrip({
  stats,
  onFixSync,
  fixingSync,
  onFilterNoGcal,
  onFilterNoConnecteam,
  onFilterUnassigned,
  // View-aware stat labels: "This month" reads truer when the calendar
  // view actually spans a month, and the underlying `stats.week` count
  // stays the same (schedule data is week-scoped) — but the label
  // shouldn't lie. Falls back to "This week" when not given.
  weekLabel = 'This week',
}) {
  // Audit §6a: the total "not in Connecteam" number conflates two very
  // different states — "assigned but not yet pushed" is the real sync gap
  // that "Fix sync now" resolves, but "no cleaner yet" is fixed by the
  // operator picking a cleaner. Prefer the split breakdown when we have it
  // so the CTA below points at the actual action.
  const needsCleaner = stats.needsCleaner ?? 0
  const assignedNotPushed = stats.assignedNotPushed ?? stats.notConnecteam ?? 0

  const hasAnyAttention =
    stats.notGcal > 0 || needsCleaner > 0 || assignedNotPushed > 0

  return (
    <div className="bg-bg border-b border-hairline px-3 sm:px-4 py-2.5">
      <div className="max-w-7xl mx-auto grid grid-cols-2 gap-2 sm:gap-3">
        <StatCard className="bg-panel border border-hairline rounded-lg" label="Today" value={stats.today} icon={CalendarIcon} />
        <StatCard className="bg-panel border border-hairline rounded-lg" label={weekLabel} value={stats.week} icon={Clock} />
      </div>
      {hasAnyAttention && (
        // Hidden on phones — a compact amber alert button in the sticky toolbar
        // takes over on mobile so this banner doesn't eat scroll real estate.
        <div className="hidden sm:flex max-w-7xl mx-auto mt-2 flex-wrap items-center gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium">Needs attention:</span>
          {stats.notGcal > 0 && (
            <button onClick={onFilterNoGcal} className="underline underline-offset-2 hover:text-amber-900" title="Filter list to jobs not on Google">
              {stats.notGcal} not on Google yet
            </button>
          )}
          {stats.notGcal > 0 && needsCleaner > 0 && <span className="text-amber-300">·</span>}
          {needsCleaner > 0 && (
            <button
              onClick={onFilterUnassigned || onFilterNoConnecteam}
              className="underline underline-offset-2 hover:text-amber-900"
              title="Filter list to jobs that still need a cleaner assignment"
            >
              {needsCleaner} need a cleaner before dispatch
            </button>
          )}
          {needsCleaner > 0 && assignedNotPushed > 0 && <span className="text-amber-300">·</span>}
          {assignedNotPushed > 0 && (
            <button onClick={onFilterNoConnecteam} className="underline underline-offset-2 hover:text-amber-900" title="Filter list to assigned jobs not yet in Connecteam">
              {assignedNotPushed} assigned but not yet pushed
            </button>
          )}
          {/* "Fix sync now" only makes sense for the pushed queue — a
              cleaner-less job can't dispatch no matter how many times you
              click it. Hide the button when the only outstanding number is
              needs-cleaner + not-on-Google (the Google fixer runs from the
              tools menu). */}
          {onFixSync && assignedNotPushed > 0 && (
            <button
              onClick={onFixSync}
              disabled={fixingSync}
              className="ml-auto shrink-0 text-[12px] font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 disabled:opacity-60 border border-amber-300 rounded-md px-2.5 py-1 transition-colors"
              data-testid="fix-sync-now"
            >
              {fixingSync ? 'Fixing…' : 'Fix sync now'}
            </button>
          )}
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

