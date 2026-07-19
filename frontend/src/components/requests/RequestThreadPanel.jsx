import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageCircle, Phone, Mail, ExternalLink, AlertTriangle } from 'lucide-react'
import { dayLabel } from '../comms/utils'
import { DaySeparator } from '../comms/primitives'
import { MessageBubble } from '../comms/MessageBubble'
import { ComposeBar } from '../comms/ComposeBar'
import { useIntakeThread } from '../../hooks/useIntakeThread'
import { post } from '../../api'

/** Inline two-way conversation embedded in the Requests drawer — so an
 *  operator can ask a lead a question and see the reply without leaving
 *  the page. A trimmed-down sibling of the full Comms inbox: single
 *  contact, no folders/assign/priority, but the same message bubbles and
 *  compose bar so a thread started here looks identical once it shows up
 *  in Comms.
 *
 *  Before the first message, there's no conversation row yet (leads
 *  predate any Client/Conversation), so `detail` is null and the operator
 *  picks SMS or Email via the channel toggle. Once something is sent,
 *  the hook resolves the new conversation and this locks to its channel
 *  — a thread only ever lives on one channel at a time, same as Comms. */
export function RequestThreadPanel({ intake }) {
  const navigate = useNavigate()
  const { detail, loading, channel, setChannel, send, sending, error } = useIntakeThread(intake)

  const [reply, setReply] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const [flash, setFlash] = useState(null)
  const [draftingAI, setDraftingAI] = useState(false)

  const groupedMessages = useMemo(() => {
    if (!detail?.messages) return []
    const items = []
    let lastDay = null
    detail.messages.forEach((m, i) => {
      const day = new Date(m.created_at).toDateString()
      if (day !== lastDay) {
        items.push({ type: 'day', label: dayLabel(m.created_at), key: `day-${day}` })
        lastDay = day
      }
      const prev = detail.messages[i - 1]
      const isFirst = !prev || prev.direction !== m.direction || prev.is_internal_note !== m.is_internal_note ||
        new Date(m.created_at).toDateString() !== new Date(prev.created_at).toDateString()
      items.push({ type: 'message', data: m, isFirst, key: `msg-${m.id}` })
    })
    return items
  }, [detail?.messages])

  const handleSend = async () => {
    const ok = await send({ body: reply, subject: replySubject, isNote: noteMode })
    if (ok) {
      setReply(''); setReplySubject('')
      setFlash({ ok: true, msg: noteMode ? 'Note saved' : 'Sent!' })
    } else {
      setFlash({ ok: false, msg: 'Send failed — see below' })
    }
    setTimeout(() => setFlash(null), 3000)
  }

  const draftWithAI = async () => {
    if (!intake?.id || draftingAI) return
    setDraftingAI(true)
    try {
      const ch = detail?.channel || channel
      const res = await post(`/api/ai/draft-lead-reply/${intake.id}`, { channel: ch })
      if (res?.message) {
        setReply(res.message)
        if (ch === 'email' && res.subject) setReplySubject(res.subject)
        setFlash({ ok: true, msg: 'Drafted — edit & send' })
      } else {
        setFlash({ ok: false, msg: 'Could not draft a reply' })
      }
    } catch {
      setFlash({ ok: false, msg: 'Could not draft a reply' })
    } finally {
      setDraftingAI(false)
      setTimeout(() => setFlash(null), 3000)
    }
  }

  const hasPhone = !!intake?.phone
  const hasEmail = !!intake?.email
  const effectiveChannel = detail?.channel || channel
  // Pseudo-detail for ComposeBar before any conversation exists — it only
  // reads .channel and .subject off this prop.
  const composeDetail = detail || { channel: effectiveChannel, subject: null }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: channel toggle (only while no thread exists yet) + link out
          to the full inbox for assign/priority/status controls this panel
          doesn't surface. */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-hairline bg-bg shrink-0">
        {!detail ? (
          <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
            {[
              { key: 'sms', label: 'SMS', icon: Phone, enabled: hasPhone },
              { key: 'email', label: 'Email', icon: Mail, enabled: hasEmail },
            ].map(ch => {
              const Icon = ch.icon
              return (
                <button
                  key={ch.key}
                  disabled={!ch.enabled}
                  onClick={() => setChannel(ch.key)}
                  title={ch.enabled ? undefined : `No ${ch.label.toLowerCase()} on file for this lead`}
                  className={`flex items-center justify-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    channel === ch.key ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" /> {ch.label}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
            <MessageCircle className="w-3.5 h-3.5" />
            {detail.channel === 'email' ? 'Email thread' : 'SMS thread'}
          </div>
        )}
        <button
          onClick={() => navigate(`/comms?q=${encodeURIComponent(intake?.email || intake?.phone || '')}`)}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3 hover:text-indigo-600 px-2 py-1 rounded transition-colors shrink-0"
        >
          Full inbox <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 bg-bg/50 min-h-[160px]">
        {loading && (
          <div className="flex justify-center py-6">
            <div className="w-5 h-5 border-2 border-hairline border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}
        {groupedMessages.map(item => (
          item.type === 'day'
            ? <DaySeparator key={item.key} label={item.label} />
            : <MessageBubble key={item.key} m={item.data} isFirst={item.isFirst} contactName={intake?.name} />
        ))}
        {!loading && groupedMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="w-10 h-10 rounded-2xl bg-panel border border-hairline flex items-center justify-center mb-2 shadow-sm">
              <MessageCircle className="w-5 h-5 text-ink-3" />
            </div>
            <p className="text-[12px] text-ink-3 max-w-[220px]">
              No messages yet. Send the first one below — it'll show up in Comms too.
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-2 text-[12px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 flex items-center gap-1.5 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="shrink-0">
        <ComposeBar
          detail={composeDetail}
          reply={reply} setReply={setReply}
          replySubject={replySubject} setReplySubject={setReplySubject}
          noteMode={noteMode} setNoteMode={setNoteMode}
          sending={sending}
          flash={flash}
          onSend={handleSend}
          allowNotes={!!detail?.id}
          onDraftAI={draftWithAI}
          draftingAI={draftingAI}
        />
      </div>
    </div>
  )
}
