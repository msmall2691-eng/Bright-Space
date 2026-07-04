/**
 * Comms — Phase 3: Modern unified inbox.
 *
 * Design references: Twenty CRM (clean panels, record detail, timeline),
 * Fieldcamp.io (unified profile, single-screen visibility, command center).
 *
 * Three-pane layout:
 *   Left   — filter tabs + conversation list (searchable, channel-filtered)
 *   Center — thread view with day separators + compose bar
 *   Right  — contact detail + activity timeline + quick actions
 *
 * New in Phase 3:
 *   • New conversation compose (SMS + Email)
 *   • Day separators in thread view
 *   • Activity timeline in contact panel (all channels in one feed)
 *   • Refined visual design (Twenty/Fieldcamp-inspired)
 *   • Keyboard shortcuts panel
 *   • Empty states with illustrations
 *   • Mobile-responsive layout
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  MessageSquare, Mail, Phone, Search, User, Clock,
  CheckCircle2, AlertTriangle,
  UserPlus, Inbox,
  ArrowLeft, Bell,
  Plus, MessageCircle, PenLine,
} from 'lucide-react'
import { get, post, getCached } from "../api"
import { formatPhone } from '../utils/display'
import { CHANNEL_CONFIG } from '../components/comms/constants'
import { relTime, dayLabel, contactDisplay } from '../components/comms/utils'
import {
  NotifPermissionButton, Avatar, ChannelBadge, SlaBadge, DaySeparator,
} from '../components/comms/primitives'
import { ConvItem } from '../components/comms/ConvItem'
import { MessageBubble } from '../components/comms/MessageBubble'
import { ComposeModal } from '../components/comms/ComposeModal'
import { ContactPanel } from '../components/comms/ContactPanel'
import { ComposeBar } from '../components/comms/ComposeBar'


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMMS PAGE
   ═══════════════════════════════════════════════════════════════════════════ */

export default function Comms() {
  // State
  const [convs, setConvs] = useState([])
  const [summary, setSummary] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [clients, setClients] = useState([])

  // Phase 8 IA: 3 folders ('active' | 'mine' | 'done') + multi-select chip
  // filters that are additive on top of the folder. Replaces the prior 6
  // single-select folders (Open / Breached / Mine / Unassigned / Unread /
  // Resolved). Old `filter` state name kept for minimal diff; values renamed.
  const [folder, setFolder] = useState('active')
  const [chipFilters, setChipFilters] = useState(() => new Set()) // 'overdue' | 'unassigned' | 'unread'
  const [channelFilter, setChannelFilter] = useState('')
  const [search, setSearch] = useState('')

  const [reply, setReply] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(null)

  const [showCompose, setShowCompose] = useState(false)
  const [showContactPanel, setShowContactPanel] = useState(true)
  const [mobileView, setMobileView] = useState('list') // list | thread
  const [toast, setToast] = useState(null) // { ok: bool, msg: string }
  const showToast = useCallback((msg, ok = true) => {
    setToast({ ok, msg })
    setTimeout(() => setToast(null), ok ? 2500 : 5000)
  }, [])

  const threadRef = useRef(null)

  // ──────── Data fetching ────────

  const loadList = useCallback(async () => {
    const params = new URLSearchParams()
    // Folder maps to status + (optionally) assignee. Status names on the
    // backend stay as 'open'/'resolved' for API compat; UI renames them.
    if (folder === 'mine') {
      params.set('status', 'open')
      const stored = localStorage.getItem('brightbase_user')
      const currentUser = stored ? JSON.parse(stored) : null
      params.set('assignee', currentUser?.email?.split('@')[0] || 'Me')
    } else if (folder === 'done') {
      params.set('status', 'resolved')
    } else {
      params.set('status', 'open') // 'active'
    }
    // Chip filters layer on top.
    if (chipFilters.has('overdue'))     params.set('sla_state', 'breached')
    if (chipFilters.has('unread'))      params.set('unread_only', 'true')
    if (chipFilters.has('unassigned') && folder !== 'mine') {
      // 'unassigned' is mutually exclusive with 'mine'; skip when on Mine.
      params.set('assignee', 'unassigned')
    }
    if (channelFilter) params.set('channel', channelFilter)
    if (search) params.set('q', search)
    try {
      const data = await get(`/api/comms/conversations?${params.toString()}`)
      setConvs(data)
    } catch (e) { console.error('[Comms] loadList:', e) }
  }, [folder, chipFilters, channelFilter, search])

  const loadSummary = useCallback(async () => {
    try { setSummary(await getCached('/api/comms/conversations/summary')) }
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

  const loadClients = useCallback(async () => {
    try { setClients(await get('/api/clients?limit=100')) }
    catch (e) { console.error('[Comms] loadClients:', e) }
  }, [])

  // ──────── Effects ────────

  useEffect(() => { loadSummary(); loadClients() }, [loadSummary, loadClients])
  // Refresh the list whenever ANY filter changes (folder / channel / chips /
  // search). loadList is rebuilt by useCallback on each of those, so depending
  // on it covers them all — previously this watched only `search`, so tapping
  // a channel/folder/chip didn't refresh until the 15s poller fired. The small
  // debounce keeps typing in the search box smooth.
  useEffect(() => { const t = setTimeout(() => loadList(), 250); return () => clearTimeout(t) }, [loadList])
  useEffect(() => { loadDetail(selectedId) }, [selectedId, loadDetail])
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [detail?.messages?.length])
  useEffect(() => {
    const iv = setInterval(() => {
      loadList(); loadSummary()
      if (selectedId) loadDetail(selectedId)
    }, 15000)
    return () => clearInterval(iv)
  }, [selectedId, loadList, loadSummary, loadDetail])

  // ──────── Actions ────────

  const sendReply = async () => {
    if (!reply.trim() || !detail) return
    setSending(true); setFlash(null)
    try {
      if (noteMode) {
        await post(`/api/comms/conversations/${detail.id}/notes`, { body: reply, author: JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Unknown' })
      } else {
        await post(`/api/comms/conversations/${detail.id}/messages`, {
          body: reply,
          subject: detail.channel === 'email' ? (replySubject || detail.subject) : undefined,
          author: JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Unknown',
        })
      }
      setReply(''); setReplySubject('')
      await loadDetail(detail.id); await loadList()
      setFlash({ ok: true, msg: noteMode ? 'Note saved' : 'Sent!' })
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

  const selectConversation = (id) => {
    setSelectedId(id)
    setMobileView('thread')
  }

  // ──────── Filter config ────────

  // Phase 8 IA: 3 folders + 3 additive filter chips. The chips can stack
  // (e.g. "Active + Overdue" or "Mine + Unread"). 'Unassigned' chip is
  // hidden when the active folder is 'Mine' since they're contradictory.
  // When a channel tab (SMS/Email) is active, scope the folder + chip badge
  // counts to that channel so the numbers match the list actually shown.
  // 'All' (channelFilter === '') uses the global totals. This fixes the
  // confusing case where "Active 15" showed above an empty SMS list because
  // all 15 conversations were on the email channel.
  const scoped = useMemo(
    () => (channelFilter ? (summary.by_channel?.[channelFilter] || {}) : summary),
    [summary, channelFilter],
  )

  // open+resolved per channel, for the All/SMS/Email tab badges — so the user
  // can see at a glance where their messages live (e.g. "Email 34").
  const channelCount = useCallback((ch) => {
    const src = ch ? (summary.by_channel?.[ch] || {}) : summary
    return (src.open || 0) + (src.resolved || 0)
  }, [summary])

  const FOLDERS = useMemo(() => ([
    { key: 'active', label: 'Active', count: scoped.open },
    { key: 'mine',   label: 'Mine',   count: null },
    { key: 'done',   label: 'Done',   count: scoped.resolved },
  ]), [scoped])

  const CHIPS = useMemo(() => ([
    { key: 'overdue',    label: 'Overdue',    icon: Clock,    count: scoped.breached },
    { key: 'unassigned', label: 'Unassigned', icon: UserPlus, count: scoped.unassigned, hideOn: 'mine' },
    { key: 'unread',     label: 'Unread',     icon: Bell,     count: scoped.unread },
  ]), [scoped])

  const toggleChip = (key) => {
    setChipFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // ──────── Message grouping with day separators ────────

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


  /* ═══════════════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════════════ */

  // Email now threads into the unified inbox (same UI as SMS) — backend
  // run_inbox_sync attaches inbound Gmail to Conversations. Email uses the
  // same conversation list as SMS.

  return (
    <div className="flex h-full bg-bg">

      {/* ═══ LEFT PANEL: Filters + Conversation List ═══ */}
      <div className={`w-[340px] border-r border-hairline bg-panel flex flex-col shrink-0
        ${mobileView === 'thread' ? 'hidden lg:flex' : 'flex'}`}>

        {/* Header */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-ink tracking-tight">Inbox</h1>
            <div className="flex items-center gap-1.5">
              <NotifPermissionButton />
              <button onClick={() => setShowCompose(true)}
                className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-sm transition-all hover:shadow-md active:scale-95">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full bg-bg border border-hairline rounded-xl pl-9 pr-3 py-2.5 text-[13px] placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 focus:bg-panel transition-all" />
          </div>
        </div>

        {/* Channel tabs */}
        <div className="px-4 pb-3">
          <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
            {[
              { key: '', label: 'All' },
              { key: 'sms', label: 'SMS', icon: Phone },
              { key: 'email', label: 'Email', icon: Mail },
            ].map(ch => {
              const Icon = ch.icon
              const count = channelCount(ch.key)
              return (
                <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
                  className={`flex-1 flex items-center justify-center gap-1 text-[12px] font-semibold px-2 py-2 rounded-lg transition-all ${
                    channelFilter === ch.key
                      ? 'bg-panel text-ink shadow-sm'
                      : 'text-ink-3 hover:text-ink-2'
                  }`}>
                  {Icon && <Icon className="w-3.5 h-3.5" />}
                  {ch.label}
                  {count > 0 && (
                    <span className={`text-[10px] font-bold tabular-nums px-1.5 py-px rounded-full ${
                      channelFilter === ch.key ? 'bg-blue-100 text-blue-700' : 'bg-bg-2 text-ink-3'
                    }`}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Phase 8: 3-tab segmented folder selector */}
        <div className="px-4 pb-2">
          <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
            {FOLDERS.map(f => (
              <button
                key={f.key}
                onClick={() => setFolder(f.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold px-2 py-2 rounded-lg transition-all ${
                  folder === f.key
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                <span>{f.label}</span>
                {f.count != null && f.count > 0 && (
                  <span className={`text-[10px] font-bold tabular-nums px-1.5 py-px rounded-full ${
                    folder === f.key ? 'bg-blue-100 text-blue-700' : 'bg-bg-2 text-ink-3'
                  }`}>
                    {f.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Phase 8: additive filter chips. Stack on top of the selected folder.
            Chips with nothing to filter (count 0) are hidden unless active, so
            the bar only shows what's actually actionable. */}
        {(() => {
          const visibleChips = CHIPS.filter(c =>
            c.hideOn !== folder && ((c.count ?? 0) > 0 || chipFilters.has(c.key))
          )
          if (visibleChips.length === 0) return null
          return (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5 border-b border-hairline">
          {visibleChips.map(({ key, label, icon: Ic, count }) => {
            const active = chipFilters.has(key)
            const isOverdue = key === 'overdue'
            return (
              <button
                key={key}
                onClick={() => toggleChip(key)}
                className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full border transition-all ${
                  active
                    ? (isOverdue
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-blue-50 text-blue-700 border-blue-200')
                    : 'bg-panel text-ink-3 border-hairline hover:bg-bg'
                }`}
              >
                <Ic className="w-3 h-3" />
                {label}
                {count != null && count > 0 && (
                  <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{count}</span>
                )}
              </button>
            )
          })}
        </div>
          )
        })()}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {convs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <div className="w-14 h-14 rounded-2xl bg-bg-2 flex items-center justify-center mb-4">
                <Inbox className="w-7 h-7 text-ink-3" />
              </div>
              <div className="text-sm font-semibold text-ink-3 mb-1">
                {channelFilter === 'sms' ? 'No SMS conversations'
                  : channelFilter === 'email' ? 'No email conversations'
                  : 'No conversations'}
              </div>
              <p className="text-[12px] text-ink-3 text-center leading-relaxed">
                {channelFilter && (channelCount('') - channelCount(channelFilter)) > 0
                  ? `Nothing here on this channel — but you have ${channelCount('') - channelCount(channelFilter)} on other channels. Tap “All” to see everything.`
                  : 'Messages will appear here when they come in, or start a new one.'}
              </p>
              {channelFilter && (channelCount('') - channelCount(channelFilter)) > 0 && (
                <button onClick={() => setChannelFilter('')}
                  className="mt-4 text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors">
                  Show all messages
                </button>
              )}
              <button onClick={() => setShowCompose(true)}
                className="mt-4 text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors">
                <Plus className="w-3.5 h-3.5" /> New Message
              </button>
            </div>
          ) : (
            convs.map(c => (
              <ConvItem key={c.id} conv={c} active={c.id === selectedId} onClick={() => selectConversation(c.id)} />
            ))
          )}
        </div>
      </div>


      {/* ═══ CENTER PANEL: Thread View ═══ */}
      <div className={`flex-1 flex flex-col min-w-0 ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
        {!detail ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center bg-bg/50">
            <div className="text-center max-w-xs">
              <div className="w-20 h-20 rounded-3xl bg-panel border border-hairline flex items-center justify-center mx-auto mb-5 shadow-sm">
                <MessageSquare className="w-10 h-10 text-ink-3" />
              </div>
              <h2 className="text-base font-bold text-ink-2 mb-2">Select a conversation</h2>
              <p className="text-[13px] text-ink-3 leading-relaxed mb-4">
                Choose from the list to read and reply, or start a new conversation.
              </p>
              <button onClick={() => setShowCompose(true)}
                className="text-[13px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-5 py-2.5 rounded-xl transition-all inline-flex items-center gap-1.5">
                <PenLine className="w-4 h-4" /> Compose
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Phase 8: Overdue banner (renamed from "SLA breached"). */}
            {detail.sla_state === 'breached' && (
              <div className="bg-red-50 border-b border-red-200 px-5 py-2.5 flex items-center gap-2 text-[12px] font-medium text-red-700">
                <Clock className="w-4 h-4" />
                Overdue — last reply {relTime(detail.last_inbound_at)} ago
              </div>
            )}

            {/* Thread header */}
            <div className="border-b border-hairline px-5 py-3.5 flex items-center gap-3 bg-panel shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              {/* Mobile back button */}
              <button onClick={() => setMobileView('list')}
                className="w-8 h-8 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3 lg:hidden">
                <ArrowLeft className="w-4 h-4" />
              </button>

              {/* Avatar with channel chip in corner — matches the inbox row */}
              <div className="relative shrink-0">
                <Avatar name={detail.client?.name || detail.external_contact} size="md" />
                {(() => {
                  const ch = CHANNEL_CONFIG[detail.channel] || CHANNEL_CONFIG.sms
                  const Ic = ch.icon
                  return (
                    <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${ch.bg} ring-2 ring-white flex items-center justify-center`}>
                      <Ic className={`w-2.5 h-2.5 ${ch.text}`} />
                    </div>
                  )
                })()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-ink text-[15px] truncate">{contactDisplay(detail)}</h2>
                  <SlaBadge state={detail.sla_state} />
                </div>
                <div className="text-[12px] text-ink-3 mt-0.5 truncate">
                  {detail.client?.phone && formatPhone(detail.client.phone)}
                  {detail.client?.phone && detail.client?.email && <span className="mx-1.5 text-ink-3">·</span>}
                  {detail.client?.email && detail.client.email}
                  {!detail.client?.phone && !detail.client?.email && detail.external_contact && formatPhone(detail.external_contact)}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5">
                <button onClick={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
                  className={`text-[12px] font-semibold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 ${
                    detail.status === 'resolved'
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 ring-1 ring-emerald-200'
                      : 'bg-bg-2 text-ink-2 hover:bg-emerald-50 hover:text-emerald-700'
                  }`}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {detail.status === 'resolved' ? 'Done' : 'Mark done'}
                </button>
                <button onClick={() => setShowContactPanel(!showContactPanel)}
                  className="w-8 h-8 rounded-lg bg-bg-2 hover:bg-bg-2 flex items-center justify-center text-ink-3 transition-colors hidden lg:flex">
                  <User className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages thread */}
            <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 bg-bg/50">
              {loadingDetail && (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-hairline border-t-blue-600 rounded-full animate-spin" />
                </div>
              )}
              {groupedMessages.map(item => {
                if (item.type === 'day') {
                  return <DaySeparator key={item.key} label={item.label} />
                }
                return <MessageBubble key={item.key} m={item.data} isFirst={item.isFirst} contactName={contactDisplay(detail)} />
              })}
              {(!detail.messages || detail.messages.length === 0) && !loadingDetail && (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="w-12 h-12 rounded-2xl bg-panel border border-hairline flex items-center justify-center mb-3 shadow-sm">
                    <MessageCircle className="w-6 h-6 text-ink-3" />
                  </div>
                  <p className="text-[13px] text-ink-3">No messages yet. Start the conversation below.</p>
                </div>
              )}
            </div>

            <ComposeBar
              detail={detail}
              reply={reply} setReply={setReply}
              replySubject={replySubject} setReplySubject={setReplySubject}
              noteMode={noteMode} setNoteMode={setNoteMode}
              sending={sending}
              flash={flash}
              onSend={sendReply}
            />
          </>
        )}
      </div>


      {/* ═══ RIGHT PANEL: Contact Detail ═══ */}
      {detail && showContactPanel && (
        <ContactPanel
          detail={detail}
          onAssign={setAssignee}
          onPriority={setPriority}
          onStatus={setStatus}
          onClose={() => setShowContactPanel(false)}
        />
      )}


      {/* ═══ Compose Modal ═══ */}
      {showCompose && (
        <ComposeModal
          clients={clients}
          onClose={() => setShowCompose(false)}
          onSent={async (response) => {
            // SMSPersistenceError: Twilio accepted but local DB write failed.
            // Distinct envelope (success: false) — surface as a warning so the
            // operator knows the recipient got the SMS but it's not in our log.
            if (response && response.success === false) {
              showToast('SMS sent, but failed to record in inbox (Twilio sid: ' + (response.twilio_sid || 'n/a') + ')', false)
              await loadList(); await loadSummary()
              return
            }
            await loadList(); await loadSummary()
            // Auto-select the new thread so the user sees their message land.
            if (response && response.conversation_id) {
              setSelectedId(response.conversation_id)
              setMobileView('thread')
            }
            showToast('Message sent')
          }}
        />
      )}


      {/* ═══ Agent Widget ═══ */}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-[60] flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border text-sm ${
          toast.ok
            ? 'bg-panel border-hairline text-ink'
            : 'bg-amber-50 border-amber-200 text-amber-900'
        }`}>
          {toast.ok
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            : <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  )
}
