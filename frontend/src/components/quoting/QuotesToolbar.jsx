import { Search } from 'lucide-react'
import SavedViewsBar from '../SavedViewsBar'

// The quote lifecycle, as a single always-visible filter. Mirrors the old
// status <select> options exactly (draft/sent/viewed/accepted/declined/
// converted) plus an "All" segment, so the ?view=/quotes/accepted pre-filter
// — which just sets statusFilter to 'accepted' — keeps lighting up the right
// segment. 'changes_requested'/'expired' aren't their own segment (they
// weren't selectable before either); they still live under All.
const STATUS_SEGMENTS = [
  { key: '',          label: 'All' },
  { key: 'draft',     label: 'Draft' },
  { key: 'sent',      label: 'Sent' },
  { key: 'viewed',    label: 'Viewed' },
  { key: 'accepted',  label: 'Accepted' },
  { key: 'declined',  label: 'Declined' },
  { key: 'converted', label: 'Converted' },
]

/** One calm command row for the Quotes tab: search, an always-visible status
 *  segmented control (counts + active state — the single source of truth for
 *  the status filter, replacing the duplicated hero pods AND the hidden
 *  dropdown so a count is never shown twice and the active status is never
 *  ambiguous), and the saved-views switcher. The status segment is a neutral
 *  token-built control (bg-bg-2 track, bg-panel on the active segment) — not a
 *  filled colored pill. Fully controlled; the parent owns every piece of
 *  state. */
export default function QuotesToolbar({
  search, setSearch,
  statusFilter, setStatusFilter, statusCounts,
  viewConfig, applyView,
}) {
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[160px] sm:max-w-xs">
        <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes…"
          className="w-full bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400" />
      </div>

      {/* Status filter — always visible so the active status is never ambiguous
          and nothing hides behind a dropdown. Neutral segmented control (no
          colored fills); scrolls horizontally at phone width. */}
      <div
        role="tablist"
        aria-label="Filter by status"
        className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 overflow-x-auto scrollbar-thin w-full sm:w-auto max-w-full">
        {STATUS_SEGMENTS.map(s => {
          const active = statusFilter === s.key
          const count = statusCounts?.[s.key]
          return (
            <button key={s.key || 'all'} role="tab" aria-selected={active}
              onClick={() => setStatusFilter(s.key)}
              className={`shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                active ? 'bg-panel text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2'
              }`}>
              {s.label}
              {count != null && (
                <span className="ml-1.5 text-[10px] text-ink-3 tabular-nums">{count}</span>
              )}
            </button>
          )
        })}
      </div>

      <div className="ml-auto">
        <SavedViewsBar entityType="quote" currentConfig={viewConfig} onApply={applyView} defaultLabel="All quotes" />
      </div>
    </div>
  )
}
