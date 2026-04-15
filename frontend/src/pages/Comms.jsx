/**
 * Comms — omnichannel unified inbox (Phase 1).
 *
 * Three-pane layout:
 *   • Left   — filtered conversation list (mine/unassigned/unread/channel/search)
 *   • Middle — selected conversation thread, reply composer, internal notes
 *   • Right  — customer context (linked client, SLA state, assignment, tags)
 *
 * Benchmarks: Intercom, HubSpot Service Hub, Front.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Send, MessageSquare, Mail, Phone, Search, User, Clock,
  CheckCircle2, AlertTriangle, Circle, StickyNote, Tag as TagIcon,
  UserPlus, ChevronRight, Inbox, Archive, Pause, Flag,
} from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post } from "../api"


// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------

function ChannelIcon({ channel, className = "w-3.5 h-3.5" }) {
  if (channel === 'email') return <Mail className={className} />
  if (channel === 'chat' || channel === 'whatsapp') return <MessageSquare className={className} />
  return <Phone className={className} />
}

function SlaBadge({ state, deadline }) {
  if (!state || state === 'none') return null
  const label = {
    met: 'SLA met',
    on_track: 'On track',
    at_risk: 'At risk',
    breached: 'Breached',
  }[state] || state
  const styles = {
    met:       'bg-green-50 text-green-700 border-green-200',
    on_track:  'bg-sky-50 text-sky-700 border-sky-200',
    at_risk:   'bg-amber-50 text-amber-700 border-amber-200',
    breached:  'bg-red-50 text-red-700 border-red-200',
  }[state] || 'bg-gray-50 text-gray-700 border-gray-200'
  const Icon = state === 'breached' || state === 'at_risk' ? AlertTriangle : CheckCircle2
  return (
    <span
      title={deadline ? `Deadline: ${new Date(deadline).toLocaleString()}` : undefined}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${styles}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  )
}

function PriorityDot({ priority }) {
  const map = {
    urgent: 'bg-red-500',
    high:   'bg-orange-500',
    normal: 'bg-gray-300',
    low:    'bg-gray-200',
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${map[priority] || map.normal}`} />
}

function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return d.toLocaleDateString()
}

const TEAM_ASSIGNEES = ['Megan', 'Unassigned']


// ---------------------------------------------------------------------------
// Conversation list item
// ---------------------------------------------------------------------------

function ConvItem({ conv, active, onClick }) {
  const name = conv.client?.name || conv.external_contact || 'Unknown contact'
  const unread = conv.unread_count > 0
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
        active ? 'bg-gray-50' : ''
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <PriorityDot priority={conv.priority} />
        <span className={`text-sm truncate flex-1 ${unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>
          {name}
        </span>
        <span className="text-[11px] text-gray-400 shrink-0">{relTime(conv.last_message_at)}</span>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
          <ChannelIcon channel={conv.channel} className="w-2.5 h-2.5" />
          {conv.channel?.toUpperCase()}
        </span>
        {conv.assignee ? (
          <span className="text-[10px] text-gray-500">{conv.assignee}</span>
        ) : (
          <span className="text-[10px] text-amber-600">Unassigned</span>
        )}
        <SlaBadge state={conv.sla_state} deadline={conv.sla_deadline} />
        {unread && (
          <span className="ml-auto bg-gray-900 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
            {conv.unread_count}
          </span>
        )}
      </div>
      <div className={`text-xs truncate ${unread ? 'text-gray-700' : 'text-gray-500'}`}>
        {conv.preview || <span className="italic text-gray-400">No messages yet</span>}
      </div>
    </button>
  )
}


// ---------------------------------------------------------------------------
// Message bubble in the thread
// ---------------------------------------------------------------------------

function MessageBubble({ m }) {
  if (m.is_internal_note) {
    return (
      <div className="flex justify-center my-2">
        <div className="max-w-[80%] bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 rounded-lg">
          <div className="flex items-center gap-1 text-[10px] font-semibold text-amber-700 mb-1">
            <StickyNote className="w-3 h-3" />
            INTERNAL NOTE {m.author ? `· ${m.author}` : ''}
            <span className="ml-auto font-normal">{relTime(m.created_at)}</span>
          </div>
          <div className="whitespace-pre-wrap">{m.body}</div>
        </div>
      </div>
    )
  }
  const outbound = m.direction === 'outbound'
  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'} my-1`}>
      <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
        outbound
          ? 'bg-gray-900 text-white rounded-br-sm'
          : 'bg-gray-100 text-gray-900 rounded-bl-sm'
      }`}>
        {m.subject && <div className="text-[11px] font-semibold opacity-75 mb-1">{m.subject}</div>}
        <div className="whitespace-pre-wrap">{m.body}</div>
        <div className={`text-[10px] mt-1 ${outbound ? 'text-gray-300' : 'text-gray-500'} text-right`}>
          {relTime(m.created_at)}
          {m.status && m.status !== 'sent' && ` · ${m.status}`}
        </div>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Comms() {
  const [convs, setConvs] = useState([])
  const [summary, setSummary] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)       // full conv + messages
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Filter state
  const [filter, setFilter] = useState('open')        // open | mine | unassigned | unread | resolved | all
  const [channelFilter, setChannelFilter] = useState('')
  const [search, setSearch] = useState('')

  // Composer
  const [reply, setReply] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(null)

  const threadRef = useRef(null)

  // --- loaders ------------------------------------------------------------
  const loadList = async () => {
    const params = new URLSearchParams()
    if (filter === 'mine')        params.set('assignee', 'Megan')
    else if (filter === 'unassigned') params.set('assignee', 'unassigned')
    else if (filter === 'unread') params.set('unread_only', 'true')
    else if (filter === 'resolved') params.set('status', 'resolved')
    else if (filter === 'open')   params.set('status', 'open')
    if (channelFilter) params.set('channel', channelFilter)
    if (search)        params.set('q', search)
    try {
      const data = await get(`/api/comms/conversations?${params.toString()}`)
      setConvs(data)
    } catch (e) { console.error(e) }
  }

  const loadSummary = async () => {
    try {
      const s = await get('/api/comms/conversations/summary')
      setSummary(s)
    } catch (e) { console.error(e) }
  }

  const loadDetail = async (id) => {
    if (!id) { setDetail(null); return }
    setLoadingDetail(true)
    try {
      const d = await get(`/api/comms/conversations/${id}`)
      setDetail(d)
      // Mark read on server + locally
      if (d.unread_count > 0) {
        await post(`/api/comms/conversations/${id}/read`)
        setDetail(prev => prev ? { ...prev, unread_count: 0 } : prev)
        setConvs(prev => prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c))
        loadSummary()
      }
    } catch (e) { console.error(e) }
    finally { setLoadingDetail(false) }
  }

  useEffect(() => { loadList(); loadSummary() }, [filter, channelFilter])
  useEffect(() => {
    const t = setTimeout(() => loadList(), 250)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => { loadDetail(selectedId) }, [selectedId])

  // Auto-scroll thread to bottom on new content
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight
    }
  }, [detail?.messages?.length])

  // Poll every 20s for new activity
  useEffect(() => {
    const iv = setInterval(() => { loadList(); loadSummary(); if (selectedId) loadDetail(selectedId) }, 20000)
    return () => clearInterval(iv)
  }, [selectedId, filter, channelFilter, search])

  // --- actions ------------------------------------------------------------
  const sendReply = async () => {
    if (!reply.trim() || !detail) return
    setSending(true); setFlash(null)
    try {
      if (noteMode) {
        await post(`/api/comms/conversations/${detail.id}/notes`, {
          body: reply, author: 'Megan',
        })
      } else {
        await post(`/api/comms/conversations/${detail.id}/messages`, {
          body: reply,
          subject: detail.channel === 'email' ? (replySubject || detail.subject) : undefined,
          author: 'Megan',
        })
      }
      setReply(''); setReplySubject('')
      await loadDetail(detail.id)
      await loadList()
      setFlash({ ok: true, msg: noteMode ? 'Note added' : 'Sent' })
    } catch (e) {
      setFlash({ ok: false, msg: String(e.message || e) })
    }
    setSending(false)
    setTimeout(() => setFlash(null), 3000)
  }

  const setAssignee = async (assignee) => {
    if (!detail) return
    const val = assignee === 'Unassigned' ? null : assignee
    await post(`/api/comms/conversations/${detail.id}/assign`, { assignee: val })
    await loadDetail(detail.id); await loadList()
  }

  const setStatus = async (status) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/status`, { status })
    await loadDetail(detail.id); await loadList(); await loadSummary()
  }

  const setPriority = async (priority) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/priority`, { priority })
    await loadDetail(detail.id); await loadList()
  }

  // --- UI -----------------------------------------------------------------
  const filters = useMemo(() => ([
    { key: 'open',       label: 'Open',       icon: Inbox,       count: summary.open },
    { key: 'mine',       label: 'Mine',       icon: User,        count: null },
    { key: 'unassigned', label: 'Unassigned', icon: UserPlus,    count: summary.unassigned },
    { key: 'unread',     label: 'Unread',     icon: Circle,      count: summary.unread },
    { key: 'resolved',   label: 'Resolved',   icon: Archive,     count: summary.resolved },
  ]), [summary])

  return (
    <div className="flex h-full bg-gray-50">

      {/* LEFT — filters + conversation list */}
      <div className="w-[320px] border-r border-gray-200 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-200">
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full bg-gray-50 border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          <div className="flex gap-1">
            {['', 'sms', 'email'].map(ch => (
              <button
                key={ch || 'all'}
                onClick={() => setChannelFilter(ch)}
                className={`flex-1 text-[11px] font-medium px-2 py-1 rounded ${
                  channelFilter === ch
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {ch ? ch.toUpperCase() : 'ALL'}
              </button>
            ))}
          </div>
        </div>

        <div className="border-b border-gray-200">
          {filters.map(({ key, label, icon: Ic, count }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                filter === key
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Ic className="w-3.5 h-3.5" />
              <span className="flex-1 text-left">{label}</span>
              {count != null && (
                <span className={`text-[11px] ${filter === key ? 'text-gray-300' : 'text-gray-400'}`}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {convs.length === 0 ? (
            <div className="text-center p-12 text-gray-400 text-sm">
              <Inbox className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              No conversations here
            </div>
          ) : (
            convs.map(c => (
              <ConvItem
                key={c.id}
                conv={c}
                active={c.id === selectedId}
                onClick={() => setSelectedId(c.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* MIDDLE — conversation thread */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {!detail ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <Inbox className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              <div className="font-medium">Select a conversation</div>
              <p className="text-sm mt-1">Pick one from the list to read and reply.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="border-b border-gray-200 px-5 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-gray-900 truncate">
                    {detail.client?.name || detail.external_contact || 'Unknown'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    <ChannelIcon channel={detail.channel} className="w-2.5 h-2.5" />
                    {detail.channel?.toUpperCase()}
                  </span>
                  <SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} />
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {detail.client?.phone || detail.external_contact}
                  {detail.client?.email && ` · ${detail.client.email}`}
                </div>
              </div>
              <button
                onClick={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
                className={`text-xs font-medium px-2.5 py-1.5 rounded-lg border ${
                  detail.status === 'resolved'
                    ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {detail.status === 'resolved' ? '✓ Resolved' : 'Mark resolved'}
              </button>
              <button
                onClick={() => setStatus('snoozed')}
                disabled={detail.status === 'snoozed'}
                className="text-xs font-medium px-2.5 py-1.5 rounded-lg border bg-white border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Pause className="w-3 h-3 inline -mt-0.5" /> Snooze
              </button>
            </div>

            {/* Thread */}
            <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
              {loadingDetail && (
                <div className="text-center text-xs text-gray-400 py-2">Loading…</div>
              )}
              {detail.messages?.map(m => <MessageBubble key={m.id} m={m} />)}
              {(!detail.messages || detail.messages.length === 0) && (
                <div className="text-center text-sm text-gray-400 py-12">
                  No messages yet. Say hello below.
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="border-t border-gray-200 p-3 bg-gray-50">
              <div className="flex gap-1 mb-2">
                <button
                  onClick={() => setNoteMode(false)}
                  className={`text-[11px] font-medium px-2 py-1 rounded ${
                    !noteMode ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600'
                  }`}
                >
                  <Send className="w-3 h-3 inline -mt-0.5" /> Reply
                </button>
                <button
                  onClick={() => setNoteMode(true)}
                  className={`text-[11px] font-medium px-2 py-1 rounded ${
                    noteMode ? 'bg-amber-500 text-white' : 'bg-white border border-gray-200 text-gray-600'
                  }`}
                >
                  <StickyNote className="w-3 h-3 inline -mt-0.5" /> Internal note
                </button>
                {flash && (
                  <span className={`ml-auto text-[11px] px-2 py-1 rounded ${
                    flash.ok ? 'text-green-700' : 'text-red-700'
                  }`}>{flash.msg}</span>
                )}
              </div>
              {detail.channel === 'email' && !noteMode && (
                <input
                  value={replySubject}
                  onChange={e => setReplySubject(e.target.value)}
                  placeholder={detail.subject ? `Re: ${detail.subject}` : 'Subject'}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm mb-2 focus:outline-none focus:border-gray-400"
                />
              )}
              <div className="flex gap-2">
                <textarea
                  value={reply}
                  onChange={e => setReply(e.target.value)}
                  rows={3}
                  placeholder={noteMode
                    ? 'Internal note — not sent to customer'
                    : `Reply via ${detail.channel?.toUpperCase()}…`}
                  className={`flex-1 bg-white border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none ${
                    noteMode
                      ? 'border-amber-200 focus:border-amber-400 bg-amber-50'
                      : 'border-gray-200 focus:border-gray-400'
                  }`}
                  onKeyDown={e => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply()
                  }}
                />
                <button
                  onClick={sendReply}
                  disabled={sending || !reply.trim()}
                  className={`px-4 rounded-lg text-sm font-medium self-stretch disabled:opacity-50 ${
                    noteMode
                      ? 'bg-amber-500 hover:bg-amber-600 text-white'
                      : 'bg-gray-900 hover:bg-gray-800 text-white'
                  }`}
                >
                  {sending ? '…' : noteMode ? 'Save' : 'Send'}
                </button>
              </div>
              <div className="text-[10px] text-gray-400 mt-1">⌘/Ctrl + Enter to send</div>
            </div>
          </>
        )}
      </div>

      {/* RIGHT — context panel */}
      {detail && (
        <div className="w-[300px] border-l border-gray-200 bg-white overflow-y-auto scrollbar-thin">
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 font-semibold">
                {(detail.client?.name || detail.external_contact || '?')[0]?.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-gray-900 truncate">
                  {detail.client?.name || detail.external_contact}
                </div>
                <div className="text-xs text-gray-500 capitalize">
                  {detail.client?.status || 'Unlinked contact'}
                </div>
              </div>
            </div>
            {detail.client?.phone && (
              <div className="text-xs text-gray-600 flex items-center gap-1.5 mt-1">
                <Phone className="w-3 h-3" /> {detail.client.phone}
              </div>
            )}
            {detail.client?.email && (
              <div className="text-xs text-gray-600 flex items-center gap-1.5 mt-1">
                <Mail className="w-3 h-3" /> {detail.client.email}
              </div>
            )}
            {detail.client && (
              <a href={`/clients/${detail.client.id}`}
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900">
                View client profile <ChevronRight className="w-3 h-3" />
              </a>
            )}
          </div>

          {/* Assignment */}
          <div className="p-4 border-b border-gray-200">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Assignee</div>
            <select
              value={detail.assignee || 'Unassigned'}
              onChange={e => setAssignee(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-gray-400"
            >
              {TEAM_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {/* Priority */}
          <div className="p-4 border-b border-gray-200">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Priority</div>
            <div className="grid grid-cols-4 gap-1">
              {['low', 'normal', 'high', 'urgent'].map(p => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`text-[11px] py-1.5 rounded border capitalize ${
                    detail.priority === p
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* SLA details */}
          {detail.sla_deadline && (
            <div className="p-4 border-b border-gray-200">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                First-response SLA
              </div>
              <div className="text-xs text-gray-700">
                <div>Target: {detail.sla_response_minutes} min</div>
                <div>Deadline: {new Date(detail.sla_deadline).toLocaleString()}</div>
                <div className="mt-1"><SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} /></div>
              </div>
            </div>
          )}

          {/* Tags (read-only in Phase 1) */}
          {detail.tags && detail.tags.length > 0 && (
            <div className="p-4 border-b border-gray-200">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Tags</div>
              <div className="flex flex-wrap gap-1">
                {detail.tags.map(t => (
                  <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                    <TagIcon className="w-3 h-3" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <AgentWidget
        pageContext="comms"
        prompts={[
          'Draft a follow-up SMS for my recent leads',
          'Summarize the selected conversation',
          'Help me write a thank-you message after a job',
        ]}
      />
    </div>
  )
}
