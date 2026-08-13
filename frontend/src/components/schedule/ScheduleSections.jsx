import { useState } from 'react'
import { Clock, Calendar as CalendarIcon, Trash2, ArrowLeftRight } from 'lucide-react'

/** Two sub-sections of the Schedule page, all pure props-in:
 *  - ScheduleHealthStrip: today/this-week count cards + optional
 *    out-of-sync "Needs attention" strip.
 *  - ScheduleBulkBar: "Select all visible" checkbox + Clear + bulk cancel +
 *    bulk shift ("weather day" move — Tier 4 roadmap).
 *
 *  ScheduleListView + its VisitCard were removed when the time-grid Week
 *  view superseded the old grouped-list week view — the branch was already
 *  unreachable (VALID_VIEWS = ['agenda', 'week', 'month']) and the audit
 *  called it out. */

export function ScheduleHealthStrip({
  stats,
  // View-aware stat labels: "This month" reads truer when the calendar
  // view actually spans a month, and the underlying `stats.week` count
  // stays the same (schedule data is week-scoped) — but the label
  // shouldn't lie. Falls back to "This week" when not given.
  weekLabel = 'This week',
}) {
  // Just the at-a-glance counts. The old "Needs attention" amber banner that
  // lived here was removed: the SyncHealthPill in the toolbar now owns sync
  // status + the fix action, and the toolbar filter chips ("Not on Google",
  // "Needs cleaner") own the same filtered queues — so the banner was pure
  // duplication. Fewer competing call-outs, cleaner page.
  return (
    <div className="no-print bg-bg border-b border-hairline px-3 sm:px-4 py-2">
      <div className="max-w-7xl mx-auto flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-ink-2">
          <CalendarIcon className="w-4 h-4 text-ink-3" />
          <span className="font-semibold text-ink tabular-nums">{stats.today}</span>
          <span className="text-ink-3">today</span>
        </span>
        <span className="w-px h-4 bg-hairline" />
        <span className="flex items-center gap-1.5 text-ink-2">
          <Clock className="w-4 h-4 text-ink-3" />
          <span className="font-semibold text-ink tabular-nums">{stats.week}</span>
          <span className="text-ink-3 lowercase">{weekLabel}</span>
        </span>
      </div>
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
  onBulkShift,
  bulkShifting,
}) {
  const [shiftDays, setShiftDays] = useState(1)
  return (
    <div className="no-print bg-panel border-b border-hairline px-4 py-2">
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
          <div className="flex items-center gap-2 flex-wrap justify-end" data-testid="visits-bulk-actions">
            <span className="text-xs text-ink-2 font-medium">{selectedCount} selected</span>
            <button onClick={onClear}
              className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
              Clear
            </button>
            {/* "Weather day" move — shift the whole selection by N days in
                one action instead of dragging each job individually. */}
            {onBulkShift && (
              <div className="flex items-center gap-1" title="Shift the selected visits by N days">
                <input
                  type="number"
                  value={shiftDays}
                  onChange={e => setShiftDays(parseInt(e.target.value, 10) || 0)}
                  className="w-12 text-xs border border-hairline rounded px-1.5 py-1.5 bg-panel text-ink text-center"
                  aria-label="Days to shift"
                />
                <span className="text-xs text-ink-3">days</span>
                <button onClick={() => onBulkShift(-Math.abs(shiftDays))} disabled={bulkShifting || !shiftDays}
                  data-testid="visits-bulk-shift-back"
                  title="Move back"
                  className="flex items-center gap-1 bg-bg-2 hover:bg-hairline disabled:opacity-50 text-ink-2 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors">
                  <ArrowLeftRight className="w-3.5 h-3.5" />−
                </button>
                <button onClick={() => onBulkShift(Math.abs(shiftDays))} disabled={bulkShifting || !shiftDays}
                  data-testid="visits-bulk-shift-forward"
                  title="Move forward"
                  className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-blue-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                  {bulkShifting ? 'Working...' : <>+ Shift</>}
                </button>
              </div>
            )}
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

