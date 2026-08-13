import {
  ChevronLeft, ChevronRight, Plus, Filter, Clock,
  Calendar as CalendarIcon, Wand2, Wrench, ChevronDown, SlidersHorizontal,
} from 'lucide-react'
import Button from '../ui/Button'
import SyncHealthPill from './SyncHealthPill'

// One source of truth for the views so the mobile (full-width, short labels)
// and desktop (inline, full labels) switchers never drift apart.
// [value, desktopLabel, phoneLabel].
//
// Three tabs, down from six (owner request, Aug 2026 — "I don't need all the
// tabs"): Day / Week / Month. "Day" is smart — it renders the dispatch board
// on a wide window and the agenda cards on a narrow one (half-screen, phone),
// which is what made the separate Agenda/Dispatch tabs redundant. The old
// 'upcoming' and 'google' views still render via ?view= URLs (nothing
// deleted, tab buttons only), and "Open in Google Calendar" stays in Tools.
const VIEWS = [
  ['day', 'Day', 'Day'],
  ['week', 'Week', 'Week'],
  ['month', 'Calendar', 'Month'],
]

/** Sticky top toolbar. Two deliberately different layouts, split at `md`
 *  (768px — the same threshold CalendarView uses to switch to its mobile
 *  bottom-sheet, so the header and the grid agree about "phone"):
 *
 *   • Phone (`md:hidden`): a clean two/three-row stack — identity + actions on
 *     top, a FULL-WIDTH view switcher with real touch targets below, then the
 *     date nav (non-month only). No more six controls fighting for one wrapping
 *     row.
 *   • Desktop (`hidden md:flex`): the original single compact row.
 *
 *  Pure props-in — the parent owns view/date/filter state, the tools-menu
 *  actions, and the "new job" callback. */
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
  onPreviewAutoAssign,
  onPreviewFixTimes,
  onOpenSyncSettings,
  onNewJob,
  // Passive sync-health pill: reads /api/jobs/sync-health and shows a calm
  // "Auto-sync on / Syncing / Needs attention" status so the schedule reads as
  // self-maintaining. `healthRefreshKey` forces a re-fetch after edits;
  // `onSyncForced` refreshes the grid after the pill's manual override.
  healthRefreshKey = 0,
  onSyncForced,
  // Quick-filter toggles + their live counts (in the filter-chip row).
  unassignedOnly = false,
  onToggleUnassigned,
  unassignedCount = 0,
  noGcalOnly = false,
  onToggleNoGcal,
  notGcalCount = 0,
  showGuestStays = false,
  onToggleGuestStays,
}) {
  const filterActive = selectedPropertyType !== 'all' || selectedStatus !== 'all'
    || unassignedOnly || noGcalOnly

  const toolsMenu = (
    <ToolsMenu
      open={toolsOpen}
      onClose={onCloseTools}
      onPreviewAutoAssign={onPreviewAutoAssign}
      onPreviewFixTimes={onPreviewFixTimes}
      onOpenSyncSettings={onOpenSyncSettings}
    />
  )

  const dateLabel = (opts) => new Date(currentDate).toLocaleDateString('en-US', opts)

  return (
    <div className="no-print bg-panel border-b border-hairline sticky top-0 z-10 safe-top">
      <div className="max-w-7xl mx-auto px-3 md:px-4 py-2.5 md:py-3">

        {/* ============================ PHONE ============================ */}
        <div className="md:hidden">
          {/* Row 1 — identity + a tidy cluster of icon actions. The view
              switcher has moved to its own full-width row, which frees this
              row so nothing wraps. */}
          <div className="flex items-center gap-1.5">
            <span className="bb-icon-chip grid place-items-center w-8 h-8 rounded-xl shrink-0 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              <CalendarIcon className="w-[18px] h-[18px]" />
            </span>
            <h1 className="text-base font-bold text-ink">Schedule</h1>
            <div className="flex-1" />

            <SyncHealthPill refreshKey={healthRefreshKey} onForced={onSyncForced}
              onOpenSettings={onOpenSyncSettings} />

            <IconButton onClick={onToggleFilters} label="Filters" active={filterActive}>
              <Filter className="w-[18px] h-[18px]" />
              {filterActive && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-500" />}
            </IconButton>

            <div className="relative">
              <IconButton onClick={onToggleTools} label="Tools">
                <Wrench className="w-[18px] h-[18px]" />
              </IconButton>
              {toolsMenu}
            </div>

            <button onClick={onNewJob} aria-label="New job"
              className="shrink-0 grid place-items-center w-9 h-9 rounded-lg bg-indigo-600 text-white shadow-sm active:scale-95 transition-transform">
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {/* Row 2 — the view switcher, full width, real tap targets. Short
              phone labels so five segments fit a narrow row. */}
          <div className="mt-2 flex items-center gap-0.5 bg-bg-2 rounded-xl p-1">
            {VIEWS.map(([v, , short]) => (
              <button key={v} onClick={() => onViewChange(v)}
                aria-pressed={viewMode === v}
                className={`flex-1 min-w-0 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
                  viewMode === v ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 active:bg-panel/60'}`}>
                {short}
              </button>
            ))}
          </div>

          {/* Row 3 — date nav (non-month only; month has CalendarView's own
              header, and these arrows step by a WEEK which is the wrong axis
              for a month grid). */}
          {viewMode !== 'month' && viewMode !== 'google' && (
            <div className="mt-2 flex items-center gap-2">
              <button onClick={onPrevWeek} aria-label="Previous"
                className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-3 active:scale-95 transition-transform">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="flex-1 text-center text-[13px] font-semibold text-ink-2">
                {dateLabel({ month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button onClick={onNextWeek} aria-label="Next"
                className="grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-3 active:scale-95 transition-transform">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* =========================== DESKTOP =========================== */}
        <div className="hidden md:flex items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <span className="bb-icon-chip grid place-items-center w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              <CalendarIcon className="w-[18px] h-[18px]" />
            </span>
            <h1 className="text-lg font-bold text-ink">Schedule</h1>
          </div>

          <div className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 shrink-0">
            {VIEWS.map(([v, label]) => (
              <button key={v} onClick={() => onViewChange(v)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${viewMode === v ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
                {label}
              </button>
            ))}
          </div>

          {viewMode !== 'month' && viewMode !== 'google' && (
            <div className="flex items-center gap-1 ml-1">
              <button onClick={onPrevWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Previous week">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold text-ink-2 whitespace-nowrap min-w-[64px] text-center">
                {dateLabel({ month: 'short', day: 'numeric' })}
              </span>
              <button onClick={onNextWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Next week">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="flex-1" />

          <SyncHealthPill refreshKey={healthRefreshKey} onForced={onSyncForced}
            onOpenSettings={onOpenSyncSettings} />

          <Button onClick={onToggleFilters} variant="secondary" size="sm" className="whitespace-nowrap relative"
            title="Filter by property type or status">
            <Filter className="w-4 h-4" />
            <span className="ml-1.5">Filters</span>
            {filterActive && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
            )}
          </Button>

          <div className="relative">
            <Button onClick={onToggleTools} variant="secondary" size="sm" className="whitespace-nowrap"
              title="Calendar sync & maintenance tools">
              <Wrench className="w-4 h-4" />
              <span className="ml-1.5">Tools</span>
              <ChevronDown className="w-3 h-3 ml-0.5" />
            </Button>
            {toolsMenu}
          </div>

          <Button onClick={onNewJob} variant="primary" size="sm" className="whitespace-nowrap">
            <Plus className="w-4 h-4" />
            <span className="ml-1.5">New Job</span>
          </Button>
        </div>

        {/* Filter chips — shared by both layouts, revealed via the Filters
            toggle to keep the toolbar clean. */}
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

            {/* Quick-filter chips: needs cleaner / not on Google. Live counts
                sit inside the chip so the dispatcher can see how much work
                each queue represents without clicking. Zero-count chips
                render disabled instead of hidden so the row shape doesn't
                jump around when the numbers change. */}
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

/** A square icon-only action button for the phone toolbar — big enough to tap
 *  (36px), quiet until pressed. `active` gives it a subtle selected tint. */
function IconButton({ onClick, label, active, children }) {
  return (
    <button onClick={onClick} aria-label={label}
      className={`relative shrink-0 grid place-items-center w-9 h-9 rounded-lg active:scale-95 transition-transform ${
        active ? 'bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'bg-bg-2 text-ink-2'}`}>
      {children}
    </button>
  )
}

/** The "Tools" dropdown, shared by the phone and desktop triggers so its
 *  contents never diverge. Rendered inside a `relative` trigger wrapper; the
 *  backdrop closes it on outside tap. */
function ToolsMenu({ open, onClose, onPreviewAutoAssign, onPreviewFixTimes, onOpenSyncSettings }) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 mt-1 w-60 bg-panel border border-hairline rounded-xl shadow-lg z-50 py-1">
        {/* The old "Push to Google now" item lived here. It was removed:
            pushing is automatic (background reconcile), and the passive
            Sync-health pill now carries a "Sync now" override for the rare
            do-it-this-second case — so the menu is just maintenance actions. */}
        <button onClick={() => { onClose(); onPreviewAutoAssign() }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-2 hover:bg-bg transition-colors">
          <Wand2 className="w-4 h-4" /> Auto-assign turnovers
        </button>
        <button onClick={() => { onClose(); onPreviewFixTimes() }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-2 hover:bg-bg transition-colors">
          <Clock className="w-4 h-4" /> Fix missing times
        </button>
        {onOpenSyncSettings && (
          <>
            <div className="my-1 border-t border-hairline" />
            <button onClick={() => { onClose(); onOpenSyncSettings() }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-2 hover:bg-bg transition-colors">
              <SlidersHorizontal className="w-4 h-4" /> Sync &amp; automation settings
            </button>
          </>
        )}
        <div className="my-1 border-t border-hairline" />
        <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
          onClick={onClose}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-2 hover:bg-bg transition-colors">
          <CalendarIcon className="w-4 h-4" /> Open in Google Calendar
        </a>
      </div>
    </>
  )
}

/** Small toggle chip used for the quick filters (needs cleaner / not on
 *  Google). Kept local because it shares the exact visual language of the
 *  two selects above and isn't reused elsewhere.
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
