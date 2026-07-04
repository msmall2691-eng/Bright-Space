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
import { useState, useMemo, useCallback } from 'react'
import {
  MessageSquare, Clock,
  CheckCircle2, AlertTriangle,
  UserPlus,
  Bell,
  MessageCircle, PenLine,
} from 'lucide-react'
import { dayLabel, contactDisplay } from '../components/comms/utils'
import { DaySeparator } from '../components/comms/primitives'
import { MessageBubble } from '../components/comms/MessageBubble'
import { ComposeModal } from '../components/comms/ComposeModal'
import { ContactPanel } from '../components/comms/ContactPanel'
import { ComposeBar } from '../components/comms/ComposeBar'
import { ThreadHeader } from '../components/comms/ThreadHeader'
import { InboxLeftPanel } from '../components/comms/InboxLeftPanel'
import { useCommsData } from '../hooks/useCommsData'
import { useCommsMutations } from '../hooks/useCommsMutations'


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMMS PAGE
   ═══════════════════════════════════════════════════════════════════════════ */

export default function Comms() {
  // Phase 8 IA: 3 folders ('active' | 'mine' | 'done') + multi-select chip
  // filters that are additive on top of the folder. Replaces the prior 6
  // single-select folders (Open / Breached / Mine / Unassigned / Unread /
  // Resolved). Old `filter` state name kept for minimal diff; values renamed.
  const [folder, setFolder] = useState('active')
  const [chipFilters, setChipFilters] = useState(() => new Set()) // 'overdue' | 'unassigned' | 'unread'
  const [channelFilter, setChannelFilter] = useState('')
  const [search, setSearch] = useState('')

  const {
    convs, summary,
    selectedId, setSelectedId,
    detail, loadingDetail, clients,
    threadRef,
    loadList, loadSummary, loadDetail,
  } = useCommsData({ folder, chipFilters, channelFilter, search })

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

  // ──────── Actions ────────

  const { setAssignee, setStatus, setPriority, sendReplyOrNote } = useCommsMutations({
    detail, loadDetail, loadList, loadSummary,
  })

  const sendReply = async () => {
    if (!reply.trim() || !detail) return
    setSending(true); setFlash(null)
    try {
      await sendReplyOrNote({ body: reply, subject: replySubject, isNote: noteMode })
      setReply(''); setReplySubject('')
      setFlash({ ok: true, msg: noteMode ? 'Note saved' : 'Sent!' })
    } catch (e) { setFlash({ ok: false, msg: String(e.message || e) }) }
    setSending(false)
    setTimeout(() => setFlash(null), 3000)
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

      <InboxLeftPanel
        convs={convs}
        selectedId={selectedId}
        mobileView={mobileView}
        search={search} setSearch={setSearch}
        channelFilter={channelFilter} setChannelFilter={setChannelFilter}
        channelCount={channelCount}
        folder={folder} setFolder={setFolder}
        FOLDERS={FOLDERS}
        CHIPS={CHIPS}
        chipFilters={chipFilters} toggleChip={toggleChip}
        onSelect={selectConversation}
        onCompose={() => setShowCompose(true)}
      />


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
            <ThreadHeader
              detail={detail}
              showContactPanel={showContactPanel}
              setShowContactPanel={setShowContactPanel}
              setMobileView={setMobileView}
              onToggleStatus={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
            />

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
