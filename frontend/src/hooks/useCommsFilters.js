import { useCallback, useMemo } from 'react'
import { Bell, Clock, UserPlus } from 'lucide-react'

/** Filter config for the Comms inbox left column: memoized folder + chip
 *  definitions with counts, plus the channel-tab count helper and a
 *  chipFilters toggler. Filter state itself (folder, chipFilters,
 *  channelFilter, search) lives in Comms.jsx so useCommsData can watch it
 *  without a circular dep — this hook just derives everything the left
 *  panel needs to render.
 *
 *  Scoping: when a channel tab (SMS/Email) is active, folder + chip badge
 *  counts scope to that channel so the numbers match the list actually
 *  shown. 'All' (channelFilter='') uses the global totals. Fixes the
 *  confusing case where "Active 15" showed above an empty SMS list because
 *  all 15 conversations were on the email channel.
 *
 *  The 'Unassigned' chip is auto-hidden when the folder is 'Mine' via the
 *  `hideOn: 'mine'` marker consumed by InboxLeftPanel. */
export function useCommsFilters({ summary, channelFilter, setChipFilters }) {
  const scoped = useMemo(
    () => (channelFilter ? (summary.by_channel?.[channelFilter] || {}) : summary),
    [summary, channelFilter],
  )

  const channelCount = useCallback((ch) => {
    const src = ch ? (summary.by_channel?.[ch] || {}) : summary
    return (src.open || 0) + (src.resolved || 0)
  }, [summary])

  const FOLDERS = useMemo(() => ([
    { key: 'active', label: 'Active', count: scoped.open },
    { key: 'mine',   label: 'Mine',   count: null },
    { key: 'done',   label: 'Done',   count: scoped.resolved },
  ]), [scoped])

  const CHIPS = useMemo(() => ([
    { key: 'overdue',    label: 'Overdue',    icon: Clock,    count: scoped.breached },
    { key: 'unassigned', label: 'Unassigned', icon: UserPlus, count: scoped.unassigned, hideOn: 'mine' },
    { key: 'unread',     label: 'Unread',     icon: Bell,     count: scoped.unread },
  ]), [scoped])

  const toggleChip = useCallback((key) => {
    setChipFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [setChipFilters])

  return { channelCount, FOLDERS, CHIPS, toggleChip }
}
