import { useEffect, useRef, useState } from 'react'
import { getCached } from '../api'

/**
 * Polls /api/comms/conversations/summary on an interval and exposes:
 *   - unreadConversations: count of conversations with unread > 0
 *   - unreadMessages: sum of unread_count across all conversations (monotonic
 *     against new arrivals between polls — used to chime on increases)
 *
 * Calls onIncrease(newTotal, prevTotal) when unreadMessages goes up between
 * polls. The very first response is treated as the baseline (no chime).
 *
 * intervalMs: default 2 min. The previous 30s default kept a uvicorn worker
 * busy with a heartbeat query every half-minute — with one worker in prod
 * that hurt 502 latency headroom. 2 min is still fresh enough for a chat
 * app (new-message notifications land immediately from the browser tab if
 * open) without hammering the summary endpoint.
 */
export function useUnreadCount({ intervalMs = 120000, onIncrease } = {}) {
  const [unreadConversations, setUnreadConversations] = useState(0)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const lastSeen = useRef(null)
  const onIncreaseRef = useRef(onIncrease)
  onIncreaseRef.current = onIncrease

  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const tick = async () => {
      // Serialize polls. Under latency spikes, overlapping requests can
      // resolve out of order; an older response landing after a newer one
      // would clobber lastSeen with a stale value and the next normal poll
      // would be misclassified as an increase, firing a false chime.
      if (inFlight) return
      inFlight = true
      try {
        const data = await getCached('/api/comms/conversations/summary')
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
      } finally {
        inFlight = false
      }
    }

    tick()
    const id = setInterval(tick, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs])

  return { unreadConversations, unreadMessages }
}
