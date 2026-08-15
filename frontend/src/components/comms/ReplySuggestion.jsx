import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { post } from '../../api'

/** Module-level suggestion cache, keyed `${conversationId}:${lastMessageId}`.
 *  Keying on the LAST message id means a new inbound message naturally gets a
 *  fresh suggestion while re-opening the same unchanged thread (or flipping
 *  between threads) reuses what we already drafted — no refetch, no flicker.
 *  Failures are cached too (text: null) so a broken/unconfigured AI endpoint
 *  is hit once per thread-state, not on every render. Dismissals live in the
 *  same entry so an X'd suggestion stays gone for that message. Module scope
 *  (not React state) survives unmount/remount as the user moves around the
 *  inbox; it resets on page reload, which is fine — drafts are cheap. */
const cache = new Map()

/** One-line suggested reply above the composer, shown when the thread's last
 *  message is an unanswered inbound. Read-only co-pilot: "Use" only fills the
 *  composer (nothing is ever auto-sent), X dismisses for this message.
 *  Loading is a single quiet skeleton line; any error renders nothing — the
 *  composer must never look broken because a suggestion failed. */
export function ReplySuggestion({ conversationId, lastMessageId, onUse }) {
  const key = `${conversationId}:${lastMessageId}`
  // Bump a counter to re-render after we mutate the cache entry (dismiss).
  const [, setTick] = useState(0)
  const [loading, setLoading] = useState(!cache.has(key))

  useEffect(() => {
    if (cache.has(key)) { setLoading(false); return }
    let alive = true
    setLoading(true)
    post(`/api/ai/draft-conversation-reply/${conversationId}`, {})
      .then(res => {
        cache.set(key, (res?.message && !res?.error)
          ? { text: res.message, subject: res.subject || '', dismissed: false }
          : { text: null })
      })
      .catch(() => { cache.set(key, { text: null }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [key, conversationId])

  if (loading) {
    return (
      <div className="rounded-md bg-bg-2 px-3 py-2">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-hairline" />
      </div>
    )
  }

  const entry = cache.get(key)
  if (!entry?.text || entry.dismissed) return null

  return (
    <div className="flex items-start gap-2 rounded-md bg-bg-2 px-3 py-2 text-[13px] text-ink-2">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />
      <p className="min-w-0 flex-1 line-clamp-2 leading-snug">{entry.text}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => onUse(entry.text, entry.subject)}
          className="text-[12px] font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
          Use
        </button>
        <button
          onClick={() => { cache.set(key, { ...entry, dismissed: true }); setTick(t => t + 1) }}
          aria-label="Dismiss suggestion"
          className="text-ink-3 hover:text-ink transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
