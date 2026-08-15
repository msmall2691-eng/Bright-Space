import { useState } from 'react'
import { Plus, Search, Phone, Mail, Inbox, SlidersHorizontal, X, Check, RotateCcw, UserPlus } from 'lucide-react'
import { NotifPermissionButton } from './primitives'
import { ConvItem } from './ConvItem'
import { SwipeRow } from './SwipeRow'

const CHANNEL_TABS = [
  { key: '', label: 'All' },
  { key: 'sms', label: 'SMS', icon: Phone },
  { key: 'email', label: 'Email', icon: Mail },
]

/** Whole left column of the Comms page. Pure presentational — every piece
 *  of state (search string, channel/folder selection, chip filters, list
 *  contents, selection) comes in as props. The parent still owns loadList
 *  and the filter state so the poller keeps working.
 *
 *  Mobile keeps the chrome lean: just the folder segmented control is always
 *  visible; channel + quick-filter chips move into a "Filters" sheet so the
 *  conversation list starts near the top instead of below five stacked bars.
 *  Desktop (lg+) has the vertical room, so it shows everything inline. */
export function InboxLeftPanel({
  convs,
  loadingList,
  selectedId,
  mobileView,
  search, setSearch,
  channelFilter, setChannelFilter,
  channelCount,
  folder, setFolder,
  FOLDERS,
  CHIPS,
  chipFilters, toggleChip,
  onSelect,
  onCompose,
  onResolve,
  onReopen,
  onAssignMine,
}) {
  // Swipe-left actions per row. In the Done folder the primary action flips to
  // "Reopen"; elsewhere it's "Done" (resolve) plus a quick "Mine" assign.
  const rowActions = (conv) => {
    if (folder === 'done') {
      return [{ key: 'reopen', label: 'Reopen', icon: RotateCcw,
                tone: 'bg-bg-3 text-ink-2', onClick: () => onReopen?.(conv.id) }]
    }
    const acts = []
    if (onAssignMine && !conv.assignee) {
      acts.push({ key: 'mine', label: 'Mine', icon: UserPlus,
                  tone: 'bg-indigo-600 text-white', onClick: () => onAssignMine(conv.id) })
    }
    if (onResolve) {
      acts.push({ key: 'done', label: 'Done', icon: Check,
                  tone: 'bg-emerald-600 text-white', onClick: () => onResolve(conv.id) })
    }
    return acts
  }
  const [filtersOpen, setFiltersOpen] = useState(false)
  const visibleChips = CHIPS.filter(c =>
    c.hideOn !== folder && ((c.count ?? 0) > 0 || chipFilters.has(c.key)),
  )
  // Badge on the mobile Filters button = how many non-default filters are on.
  const activeFilterCount = chipFilters.size + (channelFilter ? 1 : 0)

  const ChannelTabs = ({ className = '' }) => (
    <div className={`flex gap-1 bg-bg-2 rounded-lg p-1 ${className}`}>
      {CHANNEL_TABS.map(ch => {
        const Icon = ch.icon
        const count = channelCount(ch.key)
        return (
          <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
            className={`flex-1 flex items-center justify-center gap-1 text-[12px] font-semibold px-2 py-2 rounded-md transition-all ${
              channelFilter === ch.key ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}>
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {ch.label}
            {count > 0 && <span className="text-[10px] font-bold tabular-nums text-ink-3">{count}</span>}
          </button>
        )
      })}
    </div>
  )

  const Chips = ({ className = '' }) => (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {visibleChips.map(({ key, label, icon: Ic, count }) => {
        const active = chipFilters.has(key)
        const isOverdue = key === 'overdue'
        return (
          <button key={key} onClick={() => toggleChip(key)}
            className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-md border transition-all ${
              active
                ? (isOverdue ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25'
                             : 'bg-indigo-500/10 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/25')
                : 'bg-panel text-ink-3 border-hairline hover:bg-bg-2'
            }`}>
            <Ic className="w-3 h-3" />
            {label}
            {count != null && count > 0 && <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{count}</span>}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className={`w-full lg:w-[340px] border-r border-hairline bg-panel flex flex-col shrink-0
      ${mobileView === 'list' ? 'flex' : 'hidden lg:flex'}`}>

      {/* Header */}
      <div className="px-4 pt-3 pb-2.5">
        <div className="flex items-center justify-between mb-2.5">
          <h1 className="text-[15px] font-semibold tracking-tight text-ink">Inbox</h1>
          <div className="flex items-center gap-1.5">
            <NotifPermissionButton />
            {/* Mobile-only filters trigger — opens the sheet with channel + chips. */}
            <button onClick={() => setFiltersOpen(true)}
              className="lg:hidden relative w-8 h-8 rounded-md border border-hairline-2 bg-panel hover:bg-bg-2 text-ink-2 flex items-center justify-center transition-colors">
              <SlidersHorizontal className="w-4 h-4" />
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-indigo-600 text-white text-[9px] font-bold ring-2 ring-panel">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button onClick={onCompose}
              className="w-8 h-8 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center transition-colors">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search conversations…"
            className="w-full bg-bg border border-hairline rounded-xl pl-9 pr-3 py-2.5 text-base sm:text-[13px] placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-panel transition-all" />
        </div>
      </div>

      {/* Folder segmented control — always visible (the primary triage). */}
      <div className="px-4 pb-2">
        <div className="flex gap-1 bg-bg-2 rounded-lg p-1">
          {FOLDERS.map(f => (
            <button key={f.key} onClick={() => setFolder(f.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold px-2 py-2 rounded-md transition-all ${
                folder === f.key ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}>
              <span>{f.label}</span>
              {f.count != null && f.count > 0 && (
                <span className={`text-[10px] font-bold tabular-nums ${folder === f.key ? 'text-indigo-600' : 'text-ink-3'}`}>
                  {f.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Channel + chips: inline on desktop only. On mobile they live in the
          Filters sheet so the list starts near the top. */}
      <ChannelTabs className="hidden lg:flex mx-4 mb-2" />
      {visibleChips.length > 0 && <Chips className="hidden lg:flex px-4 pb-3" />}
      <div className="border-b border-hairline" />

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {loadingList && convs.length === 0 ? (
          /* Skeleton on first load — showing the empty "No conversations" state
             while the fetch is still in flight read as slow/broken. */
          <div className="divide-y divide-hairline">
            {[0, 1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="w-10 h-10 rounded-full bg-bg-2 animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 rounded bg-bg-2 animate-pulse w-1/3" />
                  <div className="h-2.5 rounded bg-bg-2 animate-pulse w-3/4" />
                </div>
              </div>
            ))}
          </div>
        ) : convs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <div className="w-14 h-14 rounded-2xl bg-bg-2 flex items-center justify-center mb-4">
              <Inbox className="w-7 h-7 text-ink-3" />
            </div>
            <div className="text-sm font-semibold text-ink-3 mb-1">
              {channelFilter === 'sms' ? 'No SMS conversations'
                : channelFilter === 'email' ? 'No email conversations'
                : 'No conversations'}
            </div>
            <p className="text-[12px] text-ink-3 text-center leading-relaxed">
              {channelFilter && (channelCount('') - channelCount(channelFilter)) > 0
                ? `Nothing here on this channel — but you have ${channelCount('') - channelCount(channelFilter)} on other channels. Tap “All” to see everything.`
                : 'Messages will appear here when they come in, or start a new one.'}
            </p>
            {channelFilter && (channelCount('') - channelCount(channelFilter)) > 0 && (
              <button onClick={() => setChannelFilter('')}
                className="mt-4 text-[12px] font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1 transition-colors">
                Show all messages
              </button>
            )}
            <button onClick={onCompose}
              className="mt-4 text-[12px] font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1 transition-colors">
              <Plus className="w-3.5 h-3.5" /> New Message
            </button>
          </div>
        ) : (
          convs.map(c => (
            <SwipeRow key={c.id} actions={rowActions(c)}>
              <ConvItem conv={c} active={c.id === selectedId} onClick={() => onSelect(c.id)} />
            </SwipeRow>
          ))
        )}
      </div>

      {/* Mobile filters bottom sheet */}
      {filtersOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex flex-col justify-end" onClick={() => setFiltersOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <div className="relative bg-panel rounded-t-2xl border-t border-hairline p-4 pb-8 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">Filters</h2>
              <button onClick={() => setFiltersOpen(false)} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="text-[11px] font-medium text-ink-3 block mb-1.5">Channel</label>
              <ChannelTabs />
            </div>
            {visibleChips.length > 0 && (
              <div>
                <label className="text-[11px] font-medium text-ink-3 block mb-1.5">Quick filters</label>
                <Chips />
              </div>
            )}
            <button onClick={() => setFiltersOpen(false)}
              className="w-full py-2.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
