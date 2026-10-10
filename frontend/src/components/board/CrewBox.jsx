import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Megaphone, X } from 'lucide-react'
import { get } from '../../api'
import { Avatar } from '../comms/primitives'
import { relTime } from '../comms/utils'
import { CrewThreadPane } from '../comms/CrewThreadPane'
import { BroadcastModal } from '../comms/CrewInbox'
import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'

/**
 * Crew comms rail on Home — the one NEW fetch on this page.
 *
 * On mount it calls GET /api/crew/threads ONCE (no poll — the shared summary
 * poll already drives the unread dot; brightbase-economy). It renders a compact
 * per-cleaner thread list (name · last-message preview · relative time · an
 * amber "N new" dot+word when unread, never a red count bubble). Tapping a row
 * opens that cleaner's thread in a right-side drawer built on the shared
 * CrewThreadPane (read + send, one office thread implementation); a send
 * refetches /api/crew/threads so the preview and unread catch up. "Message all"
 * reuses the shared BroadcastModal from CrewInbox.
 *
 * Office-only: OpsBoard renders this only for admin/manager (every /api/crew/*
 * endpoint is gated there), so it never shows for a role that would 403. Crew
 * chat carries no access details, so it's safe to preview here.
 */
const CAP = 5

export default function CrewBox({ navigate }) {
  const [threads, setThreads] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [showBroadcast, setShowBroadcast] = useState(false)

  const load = useCallback(() => {
    get('/api/crew/threads')
      .then(t => setThreads(Array.isArray(t) ? t : []))
      .catch(() => setThreads(prev => prev || []))
  }, [])
  useEffect(() => { load() }, [load])

  // No cleaners at all → render nothing (no empty furniture). A loaded-but-empty
  // roster is the only "nothing" case; while loading we still show the box.
  if (threads && threads.length === 0) return null

  const open = (threads || []).find(t => t.user_id === openId) || null
  // Active threads first, so a real conversation never hides below a cleaner
  // who's never been messaged.
  const sorted = [...(threads || [])].sort(
    (a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''))
  const visible = sorted.slice(0, CAP)
  const hidden = sorted.length - visible.length
  // A glance surface, not a roster: when NObody has a message yet, a wall of
  // "No messages yet" rows is just empty furniture (owner: Home "empty/awkward").
  // Collapse to one line — "Message all" / "Open chat" in the header still reach
  // the full roster.
  const anyActivity = (threads || []).some(t => t.last_message)

  return (
    <section data-testid="home-crew" className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Crew</h2>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setShowBroadcast(true)} title="Message several cleaners at once"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-2 transition-colors hover:text-ink">
            <Megaphone className="h-3 w-3" /> Message all
          </button>
          <button onClick={() => navigate('/comms?view=crew')}
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-link transition-all hover:gap-1">
            Open chat<ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </header>

      {!threads ? (
        <div className="divide-y divide-hairline">
          {[0, 1, 2].map(i => <div key={i} className="h-[52px] animate-pulse bg-bg-2/40" />)}
        </div>
      ) : !anyActivity ? (
        <div className="flex items-center gap-2.5 px-3.5 py-3.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.ok}`} aria-hidden="true" />
          <span className="text-[12.5px] text-ink-2">No crew messages yet.</span>
        </div>
      ) : (
        <div className="divide-y divide-hairline">
          {visible.map(t => {
            const unread = t.unread > 0
            const lastIsOffice = t.last_message?.sender === 'office'
            return (
              <button key={t.user_id} onClick={() => setOpenId(t.user_id)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2">
                <Avatar name={t.name} size="sm" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${unread ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>
                      {t.name}
                    </span>
                    {t.last_activity && (
                      <span className="shrink-0 text-[10.5px] tabular-nums text-ink-3">{relTime(t.last_activity)}</span>
                    )}
                  </span>
                  <span className={`mt-0.5 block truncate text-[11.5px] leading-snug ${unread ? 'text-ink-2' : 'text-ink-3'}`}>
                    {t.last_message
                      ? <>{lastIsOffice && <span className="text-ink-3">You: </span>}{t.last_message.body}</>
                      : 'No messages yet'}
                  </span>
                </span>
                {unread && (
                  <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold ${STATUS_TEXT.attention}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" />
                    {t.unread > 9 ? '9+' : t.unread} new
                  </span>
                )}
              </button>
            )
          })}
          {hidden > 0 && (
            <button onClick={() => navigate('/comms?view=crew')}
              className="flex w-full items-center justify-center gap-1 px-3.5 py-2 text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
              +{hidden} more
            </button>
          )}
        </div>
      )}

      {/* Right-side drawer: the shared office thread (read + send). A send
          refetches threads so the preview + unread catch up. */}
      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setOpenId(null)}>
          <div className="flex h-full w-full max-w-md flex-col border-l border-hairline bg-panel shadow-xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
              <Avatar name={open.name} size="sm" className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-ink">{open.name}</div>
                <div className="text-[11px] text-ink-3">Replies ping their phone</div>
              </div>
              <button onClick={() => setOpenId(null)} aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-md bg-bg-2 text-ink-3 hover:text-ink">
                <X className="h-4 w-4" />
              </button>
            </div>
            <CrewThreadPane
              userId={open.user_id}
              firstName={(open.name || '').split(' ')[0]}
              onLoaded={load}
              onSent={load}
            />
          </div>
        </div>
      )}

      {showBroadcast && (
        <BroadcastModal threads={threads || []} onClose={() => setShowBroadcast(false)}
          onSent={() => { setShowBroadcast(false); load() }} />
      )}
    </section>
  )
}
