import { useCallback, useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { get, post } from '../../api'
import { pushToast } from '../../utils/toastBus'

/**
 * Office side of one cleaner's chat thread — message list + composer.
 * Shared by the Messages page's Crew view (inline center pane) and the Crew
 * page drawer, so there is exactly one office thread implementation.
 *
 * Loading the thread marks the cleaner's messages read server-side (the GET
 * does it); `onLoaded` lets the parent refresh its unread counts right after.
 * `initialDraft` prefills the composer (the AI day-plan flow) — review-first:
 * nothing sends until the office hits Send.
 */
export function CrewThreadPane({ userId, firstName, initialDraft = '', onSent, onLoaded }) {
  const [msgs, setMsgs] = useState(null)
  const [draft, setDraft] = useState(initialDraft || '')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef(null)

  // Keep callbacks in refs so switching threads doesn't re-run the loader.
  const onLoadedRef = useRef(onLoaded); onLoadedRef.current = onLoaded
  const onSentRef = useRef(onSent); onSentRef.current = onSent

  useEffect(() => { setDraft(initialDraft || '') }, [userId, initialDraft])

  const load = useCallback(() => {
    get(`/api/crew/messages/${userId}`)
      .then(m => {
        setMsgs(Array.isArray(m) ? m : [])
        onLoadedRef.current?.()
        setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end' }), 50)
      })
      .catch(() => setMsgs([]))
  }, [userId])
  useEffect(() => { setMsgs(null); load() }, [load])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await post(`/api/crew/messages/${userId}`, { body: text })
      setDraft('')
      load()
      onSentRef.current?.()
    } catch (e) {
      pushToast(e.detail || e.message || 'Could not send', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {!msgs && <div className="h-24 rounded-xl bg-bg-2 animate-pulse" />}
        {msgs?.length === 0 && (
          <p className="text-[12.5px] text-ink-3 text-center pt-8">
            No messages yet — anything you send pings their phone.
          </p>
        )}
        {(msgs || []).map(m => (
          <div key={m.id} className={`max-w-[85%] ${m.sender === 'office' ? 'ml-auto' : ''}`}>
            <div className={`rounded-2xl px-3.5 py-2 text-[13.5px] whitespace-pre-wrap ${
              m.sender === 'office'
                ? 'bg-indigo-600 text-white rounded-br-md'
                : 'bg-bg-2 border border-hairline text-ink rounded-bl-md'}`}>
              {m.body}
            </div>
            <div className={`text-[10px] text-ink-3 mt-0.5 ${m.sender === 'office' ? 'text-right' : ''}`}>
              {m.sender === 'office' && m.sender_name ? `${m.sender_name} · ` : ''}
              {m.created_at ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-hairline bg-panel px-3 py-2.5 flex items-end gap-2">
        <textarea value={draft} rows={1} maxLength={2000}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={`Message ${firstName || 'them'}…`}
          className="flex-1 resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-indigo-400" />
        <button onClick={send} disabled={busy || !draft.trim()} aria-label="Send"
          className="grid place-items-center w-10 h-10 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 transition-colors">
          <Send className="w-4 h-4" />
        </button>
      </div>
    </>
  )
}
