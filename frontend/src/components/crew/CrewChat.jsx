/**
 * Messages hub (crew side) — one inbox for "the office" and your teammates.
 *
 * The Chat tab used to open the office thread directly. Now it opens this hub:
 * the office sits on top (it's the thread that matters most — owner: "chat
 * more prominent"), and each teammate a cleaner can message sits under a Team
 * heading. Tap a row → its thread; back returns here.
 *
 * Crew-to-crew is plain peer chat: the server never injects a door code,
 * address, or client name into a thread (see backend CrewPeerMessage). Rows
 * show a name only — no phone, no email.
 *
 * Fetch on open + after a thread closes (to re-clear unread) — no live socket;
 * the push notification is the "you have a reply" signal, same as the office
 * thread. In an office PREVIEW of the crew app we can't be a crew chat
 * participant, so the hub falls back to just the (preview-safe) office thread.
 */
import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Users } from 'lucide-react'
import { get, post } from '../../api'
import { CrewThread } from './CrewMessages'
import Thread from './Thread'
import { FullScreenSheet, SectionLabel, ErrorNote } from './primitives'

const fmtTime = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
  catch { return '' }
}

/** A cleaner↔cleaner thread. Mirrors CrewThread but talks to /chat/{peerId};
 *  the server stamps `mine` so the side is authoritative, not guessed. */
export function CrewPeerThread({ peerId, peerName, onClose }) {
  const [msgs, setMsgs] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    get(`/api/crew/chat/${peerId}`)
      .then(setMsgs)
      .catch(e => setError(e.detail || e.message || 'Could not load'))
  }, [peerId])
  useEffect(() => { load() }, [load])

  const send = async (text) => {
    setError(null)
    try {
      await post(`/api/crew/chat/${peerId}`, { body: text })
      load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not send')
      throw e   // Thread puts the draft back in the box
    }
  }

  return (
    <Thread
      title={peerName || 'Teammate'}
      subtitle="They get a ping when you send"
      onClose={onClose}
      loading={msgs === null && !error}
      messages={(msgs || []).map(m => ({
        key: m.id,
        mine: m.mine,
        body: m.body,
        meta: `${m.mine ? '' : `${m.sender_name || peerName || ''} · `}${fmtTime(m.created_at)}`,
      }))}
      empty="No messages yet — say hi, sort out a swap or a ride."
      error={error}
      onSend={send}
      maxLength={2000}
      placeholder={`Message ${peerName || 'teammate'}…`}
    />
  )
}

/** Unread marker: a quiet dot + bold count (design language — never a red
 *  bubble). Renders nothing at zero. */
function Unread({ n }) {
  if (!n) return null
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-600" aria-hidden="true" />
      <span className="text-[12px] font-bold text-ink tabular-nums">{n > 99 ? '99+' : n}</span>
    </span>
  )
}

function Row({ icon: Icon, name, sub, unread, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-bg-2 transition-colors">
      <span className="grid place-items-center w-9 h-9 rounded-full bg-bg-2 text-ink-3 shrink-0">
        <Icon className="w-4.5 h-4.5" />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[14px] font-semibold text-ink truncate">{name}</span>
        {sub && <span className="block text-[11px] text-ink-3 truncate mt-0.5">{sub}</span>}
      </span>
      <Unread n={unread} />
    </button>
  )
}

export default function CrewChatHub({ officeUnread = 0, previewUserId = null, onClose }) {
  const preview = previewUserId != null
  const [open, setOpen] = useState(null)      // null | 'office' | <peerId>
  const [peers, setPeers] = useState(preview ? [] : null)
  const [error, setError] = useState(null)

  const loadPeers = useCallback(() => {
    if (preview) { setPeers([]); return }
    get('/api/crew/chat/peers')
      .then(setPeers)
      .catch(e => setError(e.detail || e.message || 'Could not load your team'))
  }, [preview])
  useEffect(() => { loadPeers() }, [loadPeers])

  // Office thread — same component the Chat tab used before; back returns here.
  if (open === 'office') {
    return <CrewThread previewUserId={previewUserId}
      onClose={() => { setOpen(null); loadPeers() }} />
  }
  if (typeof open === 'number') {
    const peer = (peers || []).find(p => p.user_id === open)
    return <CrewPeerThread peerId={open} peerName={peer?.name}
      onClose={() => { setOpen(null); loadPeers() }} />
  }

  const teammate = (peers || [])
  return (
    <FullScreenSheet title="Messages" subtitle="The office and your team" onClose={onClose} flex>
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-hairline border-b border-hairline">
          <Row icon={MessageSquare} name="The office"
            sub="Questions, problems, schedule" unread={officeUnread}
            onClick={() => setOpen('office')} />
        </div>

        <div className="px-4 pt-4 pb-1 flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-ink-3" />
          <SectionLabel>Team</SectionLabel>
        </div>
        {error && <div className="px-4 pb-2"><ErrorNote>{error}</ErrorNote></div>}
        {peers === null && !error && (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">Loading your team…</p>
        )}
        {peers !== null && teammate.length === 0 && !error && (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">
            {preview
              ? "Team chat isn't shown in preview."
              : 'No teammates to message yet.'}
          </p>
        )}
        <div className="divide-y divide-hairline">
          {teammate.map(p => (
            <Row key={p.user_id} icon={MessageSquare} name={p.name}
              unread={p.unread} onClick={() => setOpen(p.user_id)} />
          ))}
        </div>
      </div>
    </FullScreenSheet>
  )
}
