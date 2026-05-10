import { useEffect, useRef, useState } from 'react'
import { get } from '../api'

/**
 * Polls /api/comms/conversations/summary on an interval and exposes:
 *   - unreadConversations: count of conversations with unread > 0
 *   - unreadMessages: sum of unread_count across all conversations (monotonic
 *     against new arrivals between polls — used to chime on increases)
 *
 * Calls onIncrease(newTotal, prevTotal) when unreadMessages goes up between
 * polls. The very first response is treated as the baseline (no chime).
 */
export function useUnreadCount({ intervalMs = 30000, onIncrease } = {}) {
  const [unreadConversations, setUnreadConversations] = useState(0)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const lastSeen = useRef(null)
  const onIncreaseRef = useRef(onIncrease)
  onIncreaseRef.current = onIncrease

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const data = await get('/api/comms/conversations/summary')
        if (cancelled) return
        const total = data.unread_messages ?? 0
        const convs = data.unread ?? 0
        setUnreadMessages(total)
        setUnreadConversations(convs)
        if (lastSeen.current !== null && total > lastSeen.current) {
          onIncreaseRef.current?.(total, lastSeen.current)
        }
        lastSeen.current = total
      } catch {
        // Silent — auth errors handled centrally; transient network blips shouldn't spam.
      }
    }

    tick()
    const id = setInterval(tick, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs])

  return { unreadConversations, unreadMessages }
}
