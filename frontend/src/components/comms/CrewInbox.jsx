import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, HardHat, Megaphone, X } from 'lucide-react'
import { get, post } from '../../api'
import { pushToast } from '../../utils/toastBus'
import { Avatar } from './primitives'
import { relTime } from './utils'
import { CrewThreadPane } from './CrewThreadPane'

/**
 * The Messages page's Crew view — every cleaner's office thread in one list
 * (unread-first by activity, same quiet dot+number counts as the client
 * inbox), the selected thread inline in the center pane, and a broadcast
 * composer that sends one message into many threads at once.
 *
 * Mobile mirrors the client inbox: exactly one pane at a time (list | thread).
 * Uses GET /api/crew/threads, GET/POST /api/crew/messages/{user_id}, and
 * POST /api/crew/messages/broadcast.
 */
export function CrewInbox({ viewToggle }) {
  const [threads, setThreads] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [mobileView, setMobileView] = useState('list') // list | thread
  const [showBroadcast, setShowBroadcast] = useState(false)

  const load = useCallback(() => {
    get('/api/crew/threads')
      .then(t => setThreads(Array.isArray(t) ? t : []))
      .catch(() => setThreads(t => t || []))
  }, [])
  useEffect(() => {
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [load])

  const selected = (threads || []).find(t => t.user_id === selectedId) || null
  const openThread = (id) => { setSelectedId(id); setMobileView('thread') }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── Left: cleaner thread list ── */}
      <div className={`w-full lg:w-[340px] border-r border-hairline bg-panel flex flex-col shrink-0
        ${mobileView === 'list' ? 'flex' : 'hidden lg:flex'}`}>
        <div className="px-4 pt-3 pb-2.5 flex items-center justify-between">
          {viewToggle}
          <button onClick={() => setShowBroadcast(true)}
            title="Message several cleaners at once"
            className="inline-flex h-8 items-center gap-1.5 text-xs font-medium text-ink-2 bg-panel border border-hairline-2 rounded-md px-2.5 hover:bg-bg-2 transition-colors">
            <Megaphone className="w-3.5 h-3.5" /> Message all
          </button>
        </div>
        <div className="border-b border-hairline" />
        <div className="flex-1 overflow-y-auto">
          {!threads ? (
            <div className="divide-y divide-hairline">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-10 h-10 rounded-full bg-bg-2 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 rounded bg-bg-2 animate-pulse w-1/3" />
                    <div className="h-2.5 rounded bg-bg-2 animate-pulse w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <div className="w-14 h-14 rounded-2xl bg-bg-2 flex items-center justify-center mb-4">
                <HardHat className="w-7 h-7 text-ink-3" />
              </div>
              <div className="text-sm font-semibold text-ink-3 mb-1">No cleaners yet</div>
              <p className="text-[12px] text-ink-3 leading-relaxed">
                Add your crew on the{' '}
                <Link to="/crew" className="text-indigo-600 hover:text-indigo-700 font-semibold">Crew page</Link>
                {' '}— each one gets a chat thread here.
              </p>
            </div>
          ) : (
            threads.map(t => {
              const unread = t.unread > 0
              const lastIsOffice = t.last_message?.sender === 'office'
              return (
                <div key={t.user_id} role="button" tabIndex={0}
                  onClick={() => openThread(t.user_id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThread(t.user_id) } }}
                  className={`group w-full text-left px-4 py-3 transition-colors border-b border-hairline cursor-pointer ${
                    t.user_id === selectedId ? 'bg-bg-2' : 'bg-panel hover:bg-bg-2/60'}`}>
                  <div className="flex items-center gap-3">
                    <Avatar name={t.name} size="md" className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-[14px] truncate flex-1 ${unread ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>
                          {t.name}
                        </span>
                        {t.last_activity && (
                          <span className="text-[11px] text-ink-3 shrink-0 tabular-nums">{relTime(t.last_activity)}</span>
                        )}
                      </div>
                      <p className={`text-[12.5px] truncate mt-0.5 ${unread ? 'text-ink-2' : 'text-ink-3'}`}>
                        {t.last_message
                          ? <>{lastIsOffice && <span className="text-ink-3">You: </span>}{t.last_message.body}</>
                          : 'No messages yet'}
                      </p>
                      {t.status === 'disabled' && (
                        <div className="mt-1 text-[10px] font-medium text-ink-3">Disabled</div>
                      )}
                    </div>
                    {unread && (
                      <span className="flex items-center gap-1 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" aria-hidden="true" />
                        <span className="text-[10px] font-bold tabular-nums text-ink">{t.unread > 9 ? '9+' : t.unread}</span>
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Center: selected thread ── */}
      <div className={`flex-1 flex-col min-w-0 ${mobileView === 'thread' ? 'flex' : 'hidden lg:flex'}`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center bg-bg/50">
            <div className="text-center max-w-xs">
              <div className="w-20 h-20 rounded-3xl bg-panel border border-hairline flex items-center justify-center mx-auto mb-5 shadow-sm">
                <HardHat className="w-10 h-10 text-ink-3" />
              </div>
              <h2 className="text-base font-bold text-ink-2 mb-2">Pick a cleaner</h2>
              <p className="text-[13px] text-ink-3 leading-relaxed">
                Each cleaner has one thread with the office — replies ping their phone.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-hairline bg-panel flex items-center gap-3">
              <button onClick={() => setMobileView('list')} aria-label="Back to list"
                className="lg:hidden grid place-items-center w-9 h-9 rounded-lg bg-bg-2 text-ink-2">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-ink truncate">{selected.name}</div>
                <div className="text-[11px] text-ink-3">Replies ping their phone</div>
              </div>
            </div>
            <CrewThreadPane
              userId={selected.user_id}
              firstName={(selected.name || '').split(' ')[0]}
              onLoaded={load}
              onSent={load}
            />
          </>
        )}
      </div>

      {showBroadcast && (
        <BroadcastModal
          threads={threads || []}
          onClose={() => setShowBroadcast(false)}
          onSent={(n) => { setShowBroadcast(false); load(); pushToast(`Sent to ${n} cleaner${n === 1 ? '' : 's'}`, 'success') }}
        />
      )}
    </div>
  )
}

/** Compose-to-many: one message, fanned into each selected cleaner's normal
 *  thread (default: everyone active). POST /api/crew/messages/broadcast. */
function BroadcastModal({ threads, onClose, onSent }) {
  const eligible = threads.filter(t => t.status !== 'disabled')
  const [body, setBody] = useState('')
  const [picked, setPicked] = useState(() => new Set(eligible.map(t => t.user_id)))
  const [busy, setBusy] = useState(false)

  const toggle = (id) => setPicked(p => {
    const next = new Set(p)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const send = async () => {
    const text = body.trim()
    if (!text || picked.size === 0 || busy) return
    setBusy(true)
    try {
      const allPicked = picked.size === eligible.length
      const res = await post('/api/crew/messages/broadcast', {
        body: text,
        // Omit user_ids for the everyone case — the backend then targets all
        // active cleaners, including any added since this list loaded.
        ...(allPicked ? {} : { user_ids: [...picked] }),
      })
      onSent(res?.sent ?? picked.size)
    } catch (e) {
      pushToast(e.detail || e.message || 'Could not send', 'error')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full sm:max-w-md bg-panel border border-hairline rounded-t-2xl sm:rounded-xl flex flex-col max-h-[85dvh]"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-ink">Message the crew</div>
            <div className="text-[11px] text-ink-3">Lands in each cleaner's thread and pings their phone</div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="grid place-items-center w-8 h-8 rounded-md bg-bg-2 text-ink-3">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          <textarea value={body} rows={3} maxLength={2000} autoFocus
            onChange={e => setBody(e.target.value)}
            placeholder="e.g. Park behind the shop today — the lot is being paved."
            className="w-full resize-none rounded-xl border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:border-indigo-400" />
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium text-ink-3">To ({picked.size} of {eligible.length})</span>
              <button onClick={() => setPicked(picked.size === eligible.length ? new Set() : new Set(eligible.map(t => t.user_id)))}
                className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700">
                {picked.size === eligible.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {eligible.map(t => (
                <label key={t.user_id} className="flex items-center gap-2.5 px-1 py-1.5 rounded-md hover:bg-bg-2 cursor-pointer">
                  <input type="checkbox" className="bb-check" checked={picked.has(t.user_id)} onChange={() => toggle(t.user_id)} />
                  <span className="text-[13px] text-ink-2">{t.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-hairline">
          <button onClick={send} disabled={busy || !body.trim() || picked.size === 0}
            className="w-full py-2.5 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
            {busy ? 'Sending…' : `Send to ${picked.size} cleaner${picked.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
