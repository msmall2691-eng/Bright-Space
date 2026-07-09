import {
  ChevronLeft, ChevronRight, Plus, RefreshCw, Filter, Clock,
  Calendar as CalendarIcon, Wand2, Wrench, ChevronDown, AlertCircle,
} from 'lucide-react'
import Button from '../ui/Button'

/** Sticky top toolbar: title · view switcher (Calendar/Day) · date nav ·
 *  Filters toggle · Tools menu · New Job. Pure props-in — the parent owns
 *  the view/date/filter state, the tools-menu actions, and the "new job"
 *  callback. Renders both the desktop date nav (inline) and the mobile-only
 *  fallback row, plus the filter-chip row when showFilters is on. */
export default function ScheduleToolbar({
  viewMode,
  onViewChange,
  currentDate,
  onPrevWeek,
  onNextWeek,
  showFilters,
  onToggleFilters,
  selectedPropertyType,
  onPropertyTypeChange,
  selectedStatus,
  onStatusChange,
  toolsOpen,
  onToggleTools,
  onCloseTools,
  syncingNow,
  onSyncNow,
  onPreviewAutoAssign,
  onPreviewFixTimes,
  onNewJob,
  // Compact mobile sync-alert button. `syncAlertCount` = total items out of
  // sync (notGcal + notConnecteam). When > 0, an amber alert pill shows in
  // the toolbar (mobile only — desktop keeps the full banner underneath).
  // `onFixSync` runs the same reconcile as the banner button.
  syncAlertCount = 0,
  onFixSync,
  fixingSync,
  // Quick-filter toggles + their live counts. Surfaces the three "which
  // jobs still need something" questions the dispatcher hits every day —
  // previously reachable only via URL params or the health-strip counters.
  unassignedOnly = false,
  onToggleUnassigned,
  unassignedCount = 0,
  noConnecteamOnly = false,
  onToggleNoConnecteam,
  notConnecteamCount = 0,
  noGcalOnly = false,
  onToggleNoGcal,
  notGcalCount = 0,
  // Month view only: Airbnb/VRBO guest-stay overlay on the calendar grid.
  // Off by default (see Schedule.jsx) — shown here so it can be turned back
  // on for a turnover-heavy week without digging through Tools.
  showGuestStays = false,
  onToggleGuestStays,
}) {
  const filterActive = selectedPropertyType !== 'all' || selectedStatus !== 'all'
    || unassignedOnly || noConnecteamOnly || noGcalOnly
  return (
    <div className="no-print bg-panel border-b border-hairline sticky top-0 z-10 safe-top">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3">
        {/* Single compact row: title · date nav · view toggle · New Job */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <h1 className="text-base sm:text-lg font-bold text-ink shrink-0">Schedule</h1>

          {/* View switcher — in-app calendar by default, one tap to Google.
              Short labels on phones so the toolbar fits narrow viewports. */}
          <div className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 shrink-0">
            {[
              ['agenda', 'Today', 'Day'],
              ['dispatch', 'Dispatch', 'Dsp'],
              ['week', 'Week', 'Wk'],
              ['month', 'Calendar', 'Cal'],
            ].map(([v, label, short]) => (
              <button key={v} onClick={() => onViewChange(v)}
                className={`px-2 sm:px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${viewMode === v ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
                <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          {/* Outer date nav — only for Day. Month mode uses CalendarView's
              own month nav, so these arrows would otherwise do nothing. */}
          {viewMode !== 'month' && (
            <div className="hidden sm:flex items-center gap-1 ml-1">
              <button onClick={onPrevWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Previous week">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold text-ink-2 whitespace-nowrap min-w-[64px] text-center">
                {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <button onClick={onNextWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Next week">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="flex-1" />

          {/* Filters hidden behind a toggle so the default view stays clean.
              A dot shows when a filter is actually narrowing the list. */}
          <Button onClick={onToggleFilters} variant="secondary" size="sm" className="whitespace-nowrap relative"
              title="Filter by property type or status">
              <Filter className="w-4 h-4" />
              <span className="hidden sm:inline ml-1.5">Filters</span>
              {filterActive && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
              )}
            </Button>

          {/* Power tools tucked into one menu to keep the toolbar clean */}
          <div className="relative">
            <Button onClick={onToggleTools} variant="secondary" size="sm" className="whitespace-nowrap"
              title="Calendar sync & maintenance tools">
              <Wrench className="w-4 h-4" />
              <span className="hidden sm:inline ml-1.5">Tools</span>
              <ChevronDown className="w-3 h-3 ml-0.5" />
            </Button>
            {toolsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={onCloseTools} />
                <div className="absolute right-0 mt-1 w-56 bg-panel border border-hairline rounded-xl shadow-lg z-50 py-1">
                  {/* Auto-sync (Settings -> Automation) keeps Google Calendar
                      current in the background — this is just the manual
                      "do it right now" fallback, one button instead of a
                      separate pull/push pair a small team shouldn't need to
                      think about. */}
                  <button onClick={() => { onCloseTools(); onSyncNow() }} disabled={syncingNow}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg disabled:opacity-50 transition-colors">
                    <RefreshCw className={`w-4 h-4 ${syncingNow ? 'animate-spin' : ''}`} /> {syncingNow ? 'Syncing…' : 'Sync now'}
                  </button>
                  <div className="my-1 border-t border-hairline" />
                  <button onClick={() => { onCloseTools(); onPreviewAutoAssign() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                    <Wand2 className="w-4 h-4" /> Auto-assign turnovers
                  </button>
                  <button onClick={() => { onCloseTools(); onPreviewFixTimes() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                    <Clock className="w-4 h-4" /> Fix missing times
                  </button>
                  <div className="my-1 border-t border-hairline" />
                  <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
                    onClick={onCloseTools}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                    <CalendarIcon className="w-4 h-4" /> Open in Google Calendar
                  </a>
                </div>
              </>
            )}
          </div>

          {/* Mobile-only sync alert pill — surfaces the "Needs attention" state
              without stealing a full row below the toolbar. Tap = Fix sync now.
              Desktop still shows the full banner underneath. */}
          {syncAlertCount > 0 && onFixSync && (
            <button
              onClick={onFixSync}
              disabled={fixingSync}
              className="sm:hidden shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-amber-100 border border-amber-300 text-amber-800 text-xs font-semibold disabled:opacity-60 active:scale-95 transition-transform"
              title={fixingSync ? 'Fixing…' : `${syncAlertCount} item(s) out of sync — tap to fix`}
              aria-label={fixingSync ? 'Fixing sync' : `${syncAlertCount} items out of sync, tap to fix`}
              data-testid="mobile-sync-alert"
            >
              <AlertCircle className={`w-3.5 h-3.5 ${fixingSync ? 'animate-pulse' : ''}`} />
              <span>{syncAlertCount}</span>
            </button>
          )}

          <Button onClick={onNewJob} variant="primary" size="sm" className="whitespace-nowrap">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline ml-1.5">New Job</span>
          </Button>
        </div>

        {/* Mobile-only date nav — desktop has it inline above */}
        {(
          <div className="sm:hidden flex items-center gap-2 mt-2">
            <button onClick={onPrevWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-ink-2 flex-1 text-center">
              {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <button onClick={onNextWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Filter chips — revealed via the Filters toggle to keep the toolbar clean */}
        {showFilters && (
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto scrollbar-thin">
            <select
              value={selectedPropertyType}
              onChange={(e) => onPropertyTypeChange(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedPropertyType === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All types</option>
              <option value="residential">Residential</option>
              <option value="str">STR</option>
              <option value="commercial">Commercial</option>
            </select>
            <select
              value={selectedStatus}
              onChange={(e) => onStatusChange(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedStatus === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All status</option>
              <option value="scheduled">Scheduled</option>
              <option value="dispatched">Dispatched</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>

            {/* Quick-filter chips: needs cleaner / not in Connecteam / not on
                Google. Live counts sit inside the chip so the dispatcher can
                see how much work each queue represents without clicking.
                Zero-count chips render disabled instead of hidden so the row
                shape doesn't jump around when the numbers change. */}
            {onToggleUnassigned && (
              <ChipToggle
                active={unassignedOnly}
                onClick={onToggleUnassigned}
                disabled={unassignedCount === 0 && !unassignedOnly}
                colorActive="bg-amber-50 text-amber-800 border-amber-200"
                testid="filter-unassigned"
              >
                Needs cleaner ({unassignedCount})
              </ChipToggle>
            )}
            {onToggleNoConnecteam && (
              <ChipToggle
                active={noConnecteamOnly}
                onClick={onToggleNoConnecteam}
                disabled={notConnecteamCount === 0 && !noConnecteamOnly}
                colorActive="bg-amber-50 text-amber-800 border-amber-200"
                testid="filter-no-connecteam"
              >
                Not in Connecteam ({notConnecteamCount})
              </ChipToggle>
            )}
            {onToggleNoGcal && (
              <ChipToggle
                active={noGcalOnly}
                onClick={onToggleNoGcal}
                disabled={notGcalCount === 0 && !noGcalOnly}
                colorActive="bg-amber-50 text-amber-800 border-amber-200"
                testid="filter-no-gcal"
              >
                Not on Google ({notGcalCount})
              </ChipToggle>
            )}
            {viewMode === 'month' && onToggleGuestStays && (
              <ChipToggle
                active={showGuestStays}
                onClick={onToggleGuestStays}
                colorActive="bg-orange-50 text-orange-700 border-orange-200"
                testid="filter-guest-stays"
              >
                Guest stays
              </ChipToggle>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Small toggle chip used for the quick filters (needs cleaner / not in
 *  Connecteam / not on Google). Kept local because it shares the exact
 *  visual language of the two selects above and isn't reused elsewhere.
 */
function ChipToggle({ active, onClick, disabled, colorActive, testid, children }) {
  const base = 'text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap transition-colors'
  const state = active
    ? colorActive
    : disabled
      ? 'bg-panel text-ink-3/50 border-hairline cursor-default'
      : 'bg-panel text-ink-3 border-hairline hover:bg-white/50 cursor-pointer'
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={`${base} ${state}`}
      data-testid={testid}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
