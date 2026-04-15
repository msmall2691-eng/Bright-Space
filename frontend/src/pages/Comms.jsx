/**
 * Comms — omnichannel unified inbox (Phase 2 redesign).
 *
 * Design references: Intercom inbox, Front inbox, Twenty CRM sidebar.
 * Three-pane layout with cleaner visual hierarchy, avatar initials,
 * traffic-light SLA indicators, and improved conversation threading.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Send, MessageSquare, Mail, Phone, Search, User, Clock,
  CheckCircle2, AlertTriangle, Circle, StickyNote, Tag as TagIcon,
  UserPlus, ChevronRight, Inbox, Archive, Pause, Flag, X,
  MoreHorizontal, ArrowLeft, Paperclip, Smile, Hash, Bell,
  Filter, Star, ChevronDown, ExternalLink, Building2, MapPin,
  PhoneCall, AtSign,
} from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post } from "../api"


// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const SLA_CONFIG = {
  met:       { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-500', label: 'Met' },
  on_track:  { bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200',    dot: 'bg-blue-500',    label: 'On track' },
  at_risk:   { bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200',   dot: 'bg-amber-500',   label: 'At risk' },
  breached:  { bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200',     dot: 'bg-red-500',     label: 'Breached' },
}


// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

function Avatar({ name, size = 'md', className = '' }) {
  const sizes = { sm: 'w-6 h-6 text-[10px]', md: 'w-8 h-8 text-xs', lg: 'w-10 h-10 text-sm' }
  const initials = (name || '?')
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  const colors = [
    'bg-blue-100 text-blue-700', 'bg-emerald-100 text-emerald-700',
    'bg-violet-100 text-violet-700', 'bg-amber-100 text-amber-700',
    'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
    'bg-indigo-100 text-indigo-700', 'bg-orange-100 text-orange-700',
  ]
  const hash = (name || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const color = colors[hash % colors.length]
  return (
    <div className={`${sizes[size]} rounded-full flex items-center justify-center font-medium shrink-0 ${color} ${className}`}>
      {initials}
    </div>
  )
}

function ChannelBadge({ channel }) {
  const config = {
    sms:      { icon: Phone, label: 'SMS', color: 'bg-emerald-50 text-emerald-700' },
    email:    { icon: Mail, label: 'Email', color: 'bg-blue-50 text-blue-700' },
    chat:     { icon: MessageSquare, label: 'Chat', color: 'bg-violet-50 text-violet-700' },
    whatsapp: { icon: MessageSquare, label: 'WhatsApp', color: 'bg-green-50 text-green-700' },
  }
  const c = config[channel] || config.sms
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md ${c.color}`}>
      <Icon className="w-2.5 h-2.5" /> {c.label}
    </span>
  )
}

function SlaBadge({ state, deadline, compact = false }) {
  if (!state || state === 'none') return null
  const c = SLA_CONFIG[state] || SLA_CONFIG.on_track
  if (compact) {
    return (
      <span title={`SLA ${c.label}${deadline ? ` — ${new Date(deadline).toLocaleString()}` : ''}`}
        className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
    )
  }
  return (
    <span title={deadline ? `Deadline: ${new Date(deadline).toLocaleString()}` : undefined}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${c.bg} ${c.text} ${c.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}

function formatPhone(p) {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  }
  return p
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
// Conversation list item (Intercom-inspired)
// ---------------------------------------------------------------------------

function ConvItem({ conv, active, onClick }) {
  const name = conv.client?.name || conv.external_contact || 'Unknown'
  const isPhone = /^\+?\d/.test(name)
  const displayName = isPhone ? formatPhone(name) : name
  const unread = conv.unread_count > 0

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 transition-all duration-150 border-l-2 ${
        active
          ? 'bg-blue-50/60 border-l-blue-600'
          : unread
            ? 'bg-white border-l-transparent hover:bg-zinc-50'
            : 'bg-white border-l-transparent hover:bg-zinc-50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Avatar name={name} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`text-[13px] truncate flex-1 ${unread ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'}`}>
              {displayName}
            </span>
            <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums">{relTime(conv.last_message_at)}</span>
          </div>
          <div className="flex items-center gap-1.5 mb-1">
            <ChannelBadge channel={conv.channel} />
            {conv.assignee ? (
              <span className="text-[10px] text-zinc-500">{conv.assignee}</span>
            ) : (
              <span className="text-[10px] text-amber-600 font-medium">Unassigned</span>
            )}
            <SlaBadge state={conv.sla_state} compact />
          </div>
          <div className={`text-[12px] leading-relaxed truncate ${unread ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {conv.preview || 'No messages yet'}
          </div>
        </div>
        {unread && (
          <span className="mt-0.5 bg-blue-600 text-white text-[10px] font-bold w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0">
            {conv.unread_count}
          </span>
        )}
      </div>
    </button>
  )
}


// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ m, isFirst, isLast }) {
  if (m.is_internal_note) {
    return (
      <div className="flex justify-center my-3">
        <div className="max-w-[85%] bg-amber-50 border border-amber-100 text-amber-900 text-[13px] px-4 py-2.5 rounded-xl">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-600 mb-1.5">
            <StickyNote className="w-3 h-3" />
            Internal note {m.author && <span className="font-normal text-amber-500">by {m.author}</span>}
            <span className="ml-auto font-normal text-amber-400">{relTime(m.created_at)}</span>
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">{m.body}</div>
        </div>
      </div>
    )
  }

  const outbound = m.direction === 'outbound'
  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'} ${isFirst ? 'mt-3' : 'mt-1'}`}>
      <div className={`max-w-[70%] px-3.5 py-2 text-[13px] leading-relaxed ${
        outbound
          ? `bg-zinc-900 text-white ${isLast ? 'rounded-2xl rounded-br-md' : 'rounded-2xl'}`
          : `bg-zinc-100 text-zinc-900 ${isLast ? 'rounded-2xl rounded-bl-md' : 'rounded-2xl'}`
      }`}>
        {m.subject && <div className="text-[11px] font-medium opacity-70 mb-1">{m.subject}</div>}
        <div className="whitespace-pre-wrap">{m.body}</div>
        <div className={`text-[10px] mt-1 ${outbound ? 'text-zinc-400' : 'text-zinc-500'} text-right`}>
          {relTime(m.created_at)}
          {m.status && m.status !== 'sent' && m.status !== 'received' && ` · ${m.status}`}
        </div>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Contact sidebar (Twenty/Attio-inspired)
// ---------------------------------------------------------------------------

function ContactPanel({ detail, onAssign, onPriority, onStatus }) {
  if (!detail) return null
  const name = detail.client?.name || detail.external_contact || 'Unknown'
  const isPhone = /^\+?\d/.test(name)

  return (
    <div className="w-[300px] border-l border-zinc-200 bg-white flex flex-col overflow-y-auto">
      <div className="p-5 border-b border-zinc-100">
        <div className="flex items-center gap-3 mb-3">
          <Avatar name={name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-zinc-900 text-[15px] truncate">
              {isPhone ? formatPhone(name) : name}
            </div>
            <div className="text-xs text-zinc-500 capitalize mt-0.5">
              {detail.client?.status || 'New contact'}
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          {detail.client?.phone && (
            <div className="text-xs text-zinc-600 flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-zinc-400" /> {formatPhone(detail.client.phone)}
            </div>
          )}
          {detail.client?.email && (
            <div className="text-xs text-zinc-600 flex items-center gap-2">
              <AtSign className="w-3.5 h-3.5 text-zinc-400" /> {detail.client.email}
            </div>
          )}
          {!detail.client?.phone && detail.external_contact && (
            <div className="text-xs text-zinc-600 flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-zinc-400" /> {formatPhone(detail.external_contact)}
            </div>
          )}
        </div>
        {detail.client && (
          <a href={`/clients/${detail.client.id}`}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
            View full profile <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="p-4 space-y-4">
        <div>
          <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">Assignee</label>
          <select
            value={detail.assignee || 'Unassigned'}
            onChange={e => onAssign(e.target.value)}
            className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-2 text-[13px] text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all"
          >
            {TEAM_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div>
          <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">Priority</label>
          <div className="grid grid-cols-4 gap-1">
            {['low', 'normal', 'high', 'urgent'].map(p => {
              const active = detail.priority === p
              const urgencyColor = {
                low: active ? 'bg-zinc-200 text-zinc-700 border-zinc-300' : '',
                normal: active ? 'bg-blue-600 text-white border-blue-600' : '',
                high: active ? 'bg-amber-500 text-white border-amber-500' : '',
                urgent: active ? 'bg-red-600 text-white border-red-600' : '',
              }
              return (
                <button key={p} onClick={() => onPriority(p)}
                  className={`text-[11px] py-1.5 rounded-md border capitalize transition-all ${
                    active ? urgencyColor[p] : 'bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-50'
                  }`}>
                  {p}
                </button>
              )
            })}
          </div>
        </div>

        {detail.sla_deadline && (
          <div>
            <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">First-Response SLA</label>
            <div className="bg-zinc-50 rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">Target</span>
                <span className="text-zinc-700 font-medium">{detail.sla_response_minutes} min</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">Deadline</span>
                <span className="text-zinc-700 font-medium">
                  {new Date(detail.sla_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="pt-1"><SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} /></div>
            </div>
          </div>
        )}

        {detail.tags && detail.tags.length > 0 && (
          <div>
            <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">Tags</label>
            <div className="flex flex-wrap gap-1">
              {detail.tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
                  <Hash className="w-2.5 h-2.5" /> {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Main Comms page
// ---------------------------------------------------------------------------

export default function Comms() {
  const [convs, setConvs] = useState([])
  const [summary, setSummary] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const [filter, setFilter] = useState('open')
  const [channelFilter, setChannelFilter] = useState('')
  const [search, setSearch] = useState('')

  const [reply, setReply] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(null)

  const threadRef = useRef(null)

  const loadList = useCallback(async () => {
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
    } catch (e) { console.error('[Comms] loadList:', e) }
  }, [filter, channelFilter, search])

  const loadSummary = useCallback(async () => {
    try { setSummary(await get('/api/comms/conversations/summary')) }
    catch (e) { console.error('[Comms] loadSummary:', e) }
  }, [])

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return }
    setLoadingDetail(true)
    try {
      const d = await get(`/api/comms/conversations/${id}`)
      setDetail(d)
      if (d.unread_count > 0) {
        await post(`/api/comms/conversations/${id}/read`)
        setDetail(prev => prev ? { ...prev, unread_count: 0 } : prev)
        setConvs(prev => prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c))
        loadSummary()
      }
    } catch (e) { console.error('[Comms] loadDetail:', e) }
    finally { setLoadingDetail(false) }
  }, [loadSummary])

  useEffect(() => { loadList(); loadSummary() }, [loadList, loadSummary])
  useEffect(() => { const t = setTimeout(() => loadList(), 300); return () => clearTimeout(t) }, [search])
  useEffect(() => { loadDetail(selectedId) }, [selectedId, loadDetail])
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [detail?.messages?.length])
  useEffect(() => {
    const iv = setInterval(() => { loadList(); loadSummary(); if (selectedId) loadDetail(selectedId) }, 15000)
    return () => clearInterval(iv)
  }, [selectedId, loadList, loadSummary, loadDetail])

  const sendReply = async () => {
    if (!reply.trim() || !detail) return
    setSending(true); setFlash(null)
    try {
      if (noteMode) {
        await post(`/api/comms/conversations/${detail.id}/notes`, { body: reply, author: 'Megan' })
      } else {
        await post(`/api/comms/conversations/${detail.id}/messages`, {
          body: reply,
          subject: detail.channel === 'email' ? (replySubject || detail.subject) : undefined,
          author: 'Megan',
        })
      }
      setReply(''); setReplySubject('')
      await loadDetail(detail.id); await loadList()
      setFlash({ ok: true, msg: noteMode ? 'Note saved' : 'Message sent' })
    } catch (e) { setFlash({ ok: false, msg: String(e.message || e) }) }
    setSending(false)
    setTimeout(() => setFlash(null), 3000)
  }

  const setAssignee = async (a) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/assign`, { assignee: a === 'Unassigned' ? null : a })
    await loadDetail(detail.id); await loadList()
  }
  const setStatus = async (s) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/status`, { status: s })
    await loadDetail(detail.id); await loadList(); await loadSummary()
  }
  const setPriority = async (p) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/priority`, { priority: p })
    await loadDetail(detail.id); await loadList()
  }

  const filters = useMemo(() => ([
    { key: 'open',       label: 'Open',       icon: Inbox,        count: summary.open },
    { key: 'mine',       label: 'Mine',       icon: User,         count: null },
    { key: 'unassigned', label: 'Unassigned', icon: UserPlus,     count: summary.unassigned },
    { key: 'unread',     label: 'Unread',     icon: Bell,         count: summary.unread },
    { key: 'resolved',   label: 'Resolved',   icon: CheckCircle2, count: summary.resolved },
  ]), [summary])

  const detailName = detail?.client?.name || detail?.external_contact || 'Unknown'
  const isDetailPhone = /^\+?\d/.test(detailName)

  return (
    <div className="flex h-full bg-white">

      {/* ===== LEFT: filters + list ===== */}
      <div className="w-[320px] border-r border-zinc-200 bg-zinc-50 flex flex-col">
        <div className="p-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full bg-white border border-zinc-200 rounded-lg pl-8 pr-3 py-2 text-[13px] placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all" />
          </div>
        </div>

        <div className="px-3 pb-2">
          <div className="flex gap-1 bg-zinc-100 rounded-lg p-0.5">
            {[{ key: '', label: 'All' }, { key: 'sms', label: 'SMS' }, { key: 'email', label: 'Email' }].map(ch => (
              <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
                className={`flex-1 text-[11px] font-medium px-2 py-1.5 rounded-md transition-all ${
                  channelFilter === ch.key ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}>
                {ch.label}
              </button>
            ))}
          </div>
        </div>

        <div className="border-y border-zinc-200 bg-white">
          {filters.map(({ key, label, icon: Ic, count }) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-[13px] transition-all ${
                filter === key
                  ? 'bg-blue-50 text-blue-700 font-medium border-l-2 border-l-blue-600'
                  : 'text-zinc-600 hover:bg-zinc-50 border-l-2 border-l-transparent'
              }`}>
              <Ic className={`w-4 h-4 ${filter === key ? 'text-blue-600' : 'text-zinc-400'}`} />
              <span className="flex-1 text-left">{label}</span>
              {count != null && (
                <span className={`text-[11px] tabular-nums font-medium px-1.5 py-0.5 rounded-full min-w-[20px] text-center ${
                  filter === key ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
                }`}>{count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {convs.length === 0 ? (
            <div className="text-center py-16 px-6">
              <div className="w-12 h-12 rounded-full bg-zinc-100 flex items-center justify-center mx-auto mb-3">
                <Inbox className="w-6 h-6 text-zinc-300" />
              </div>
              <div className="text-sm font-medium text-zinc-500 mb-1">No conversations</div>
              <p className="text-xs text-zinc-400">Messages will appear here when they come in.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-100">
              {convs.map(c => (
                <ConvItem key={c.id} conv={c} active={c.id === selectedId} onClick={() => setSelectedId(c.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== MIDDLE: thread ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {!detail ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto mb-4">
                <MessageSquare className="w-8 h-8 text-zinc-300" />
              </div>
              <div className="text-base font-medium text-zinc-500 mb-1">Select a conversation</div>
              <p className="text-sm text-zinc-400">Choose from the list to read and reply.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-zinc-200 px-5 py-3 flex items-center gap-3 bg-white">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-zinc-900 text-[15px] truncate">
                    {isDetailPhone ? formatPhone(detailName) : detailName}
                  </span>
                  <ChannelBadge channel={detail.channel} />
                  <SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} />
                </div>
                <div className="text-xs text-zinc-500 mt-0.5 truncate">
                  {detail.client?.phone && formatPhone(detail.client.phone)}
                  {detail.client?.email && (detail.client?.phone ? ` · ${detail.client.email}` : detail.client.email)}
                  {!detail.client?.phone && !detail.client?.email && detail.external_contact && formatPhone(detail.external_contact)}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-all ${
                    detail.status === 'resolved'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                      : 'bg-white border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                  }`}>
                  {detail.status === 'resolved' ? '✓ Resolved' : 'Resolve'}
                </button>
                <button onClick={() => setStatus('snoozed')} disabled={detail.status === 'snoozed'}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border bg-white border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 transition-all">
                  <Clock className="w-3 h-3 inline -mt-0.5 mr-0.5" /> Snooze
                </button>
              </div>
            </div>

            <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 bg-zinc-50/50">
              {loadingDetail && (
                <div className="flex justify-center py-4">
                  <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
                </div>
              )}
              {detail.messages?.map((m, i, arr) => {
                const prev = arr[i - 1]
                const next = arr[i + 1]
                const isFirst = !prev || prev.direction !== m.direction || prev.is_internal_note !== m.is_internal_note
                const isLast = !next || next.direction !== m.direction || next.is_internal_note !== m.is_internal_note
                return <MessageBubble key={m.id} m={m} isFirst={isFirst} isLast={isLast} />
              })}
              {(!detail.messages || detail.messages.length === 0) && !loadingDetail && (
                <div className="text-center py-16 text-sm text-zinc-400">No messages yet. Say hello below.</div>
              )}
            </div>

            <div className="border-t border-zinc-200 bg-white p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <button onClick={() => setNoteMode(false)}
                  className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${
                    !noteMode ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                  }`}>
                  <Send className="w-3 h-3" /> Reply
                </button>
                <button onClick={() => setNoteMode(true)}
                  className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${
                    noteMode ? 'bg-amber-500 text-white' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                  }`}>
                  <StickyNote className="w-3 h-3" /> Internal note
                </button>
                {flash && (
                  <span className={`ml-auto text-[11px] font-medium px-2 py-0.5 rounded-md ${
                    flash.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                  }`}>{flash.msg}</span>
                )}
              </div>
              {detail.channel === 'email' && !noteMode && (
                <input value={replySubject} onChange={e => setReplySubject(e.target.value)}
                  placeholder={detail.subject ? `Re: ${detail.subject}` : 'Subject'}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-1.5 text-[13px] mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400" />
              )}
              <div className="flex gap-2">
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2}
                  placeholder={noteMode ? 'Write an internal note (not sent to customer)...' : `Reply via ${detail.channel?.toUpperCase()}...`}
                  className={`flex-1 border rounded-xl px-3.5 py-2.5 text-[13px] resize-none focus:outline-none focus:ring-2 transition-all leading-relaxed ${
                    noteMode ? 'border-amber-200 bg-amber-50/50 focus:ring-amber-500/20' : 'border-zinc-200 bg-white focus:ring-blue-500/20'
                  }`}
                  onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply() }} />
                <button onClick={sendReply} disabled={sending || !reply.trim()}
                  className={`px-5 rounded-xl text-[13px] font-medium self-stretch disabled:opacity-40 transition-all ${
                    noteMode ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-zinc-900 hover:bg-zinc-800 text-white'
                  }`}>
                  {sending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : noteMode ? 'Save' : 'Send'}
                </button>
              </div>
              <div className="text-[10px] text-zinc-400 mt-1.5 pl-1">
                {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'} + Enter to send
              </div>
            </div>
          </>
        )}
      </div>

      {/* ===== RIGHT: contact panel ===== */}
      {detail && <ContactPanel detail={detail} onAssign={setAssignee} onPriority={setPriority} onStatus={setStatus} />}

      <AgentWidget pageContext="comms" prompts={[
        'Draft a follow-up SMS for my recent leads',
        'Summarize the selected conversation',
        'Help me write a thank-you message after a job',
      ]} />
    </div>
  )
}
