import { Plus, Search, Phone, Mail, Inbox } from 'lucide-react'
import { NotifPermissionButton } from './primitives'
import { ConvItem } from './ConvItem'

const CHANNEL_TABS = [
  { key: '', label: 'All' },
  { key: 'sms', label: 'SMS', icon: Phone },
  { key: 'email', label: 'Email', icon: Mail },
]

/** Whole left column of the Comms page. Pure presentational — every piece
 *  of state (search string, channel/folder selection, chip filters, list
 *  contents, selection) comes in as props. The parent still owns loadList
 *  and the filter state so the 15s poller keeps working. */
export function InboxLeftPanel({
  convs,
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
}) {
  const visibleChips = CHIPS.filter(c =>
    c.hideOn !== folder && ((c.count ?? 0) > 0 || chipFilters.has(c.key)),
  )

  return (
    <div className={`w-full lg:w-[340px] border-r border-hairline bg-panel flex flex-col shrink-0
      ${mobileView === 'thread' ? 'hidden lg:flex' : 'flex'}`}>

      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold text-ink tracking-tight">Inbox</h1>
          <div className="flex items-center gap-1.5">
            <NotifPermissionButton />
            <button onClick={onCompose}
              className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-sm transition-all hover:shadow-md active:scale-95">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full bg-bg border border-hairline rounded-xl pl-9 pr-3 py-2.5 text-[13px] placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 focus:bg-panel transition-all" />
        </div>
      </div>

      {/* Channel tabs */}
      <div className="px-4 pb-3">
        <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
          {CHANNEL_TABS.map(ch => {
            const Icon = ch.icon
            const count = channelCount(ch.key)
            return (
              <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
                className={`flex-1 flex items-center justify-center gap-1 text-[12px] font-semibold px-2 py-2 rounded-lg transition-all ${
                  channelFilter === ch.key
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-ink-3 hover:text-ink-2'
                }`}>
                {Icon && <Icon className="w-3.5 h-3.5" />}
                {ch.label}
                {count > 0 && (
                  <span className={`text-[10px] font-bold tabular-nums px-1.5 py-px rounded-full ${
                    channelFilter === ch.key ? 'bg-blue-100 text-blue-700' : 'bg-bg-2 text-ink-3'
                  }`}>{count}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Phase 8: 3-tab segmented folder selector */}
      <div className="px-4 pb-2">
        <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
          {FOLDERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFolder(f.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold px-2 py-2 rounded-lg transition-all ${
                folder === f.key
                  ? 'bg-panel text-ink shadow-sm'
                  : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <span>{f.label}</span>
              {f.count != null && f.count > 0 && (
                <span className={`text-[10px] font-bold tabular-nums px-1.5 py-px rounded-full ${
                  folder === f.key ? 'bg-blue-100 text-blue-700' : 'bg-bg-2 text-ink-3'
                }`}>
                  {f.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Phase 8: additive filter chips. Stack on top of the selected folder.
          Chips with nothing to filter (count 0) are hidden unless active, so
          the bar only shows what's actually actionable. */}
      {visibleChips.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5 border-b border-hairline">
          {visibleChips.map(({ key, label, icon: Ic, count }) => {
            const active = chipFilters.has(key)
            const isOverdue = key === 'overdue'
            return (
              <button
                key={key}
                onClick={() => toggleChip(key)}
                className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full border transition-all ${
                  active
                    ? (isOverdue
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-blue-50 text-blue-700 border-blue-200')
                    : 'bg-panel text-ink-3 border-hairline hover:bg-bg'
                }`}
              >
                <Ic className="w-3 h-3" />
                {label}
                {count != null && count > 0 && (
                  <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{count}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {convs.length === 0 ? (
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
                className="mt-4 text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors">
                Show all messages
              </button>
            )}
            <button onClick={onCompose}
              className="mt-4 text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors">
              <Plus className="w-3.5 h-3.5" /> New Message
            </button>
          </div>
        ) : (
          convs.map(c => (
            <ConvItem key={c.id} conv={c} active={c.id === selectedId} onClick={() => onSelect(c.id)} />
          ))
        )}
      </div>
    </div>
  )
}
