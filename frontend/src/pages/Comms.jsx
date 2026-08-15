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
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  MessageSquare,
  CheckCircle2, AlertTriangle,
  MessageCircle, PenLine,
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import { post } from '../api'
import { dayLabel, contactDisplay, firstNameOf, apptReminderText } from '../components/comms/utils'
import { DaySeparator } from '../components/comms/primitives'
import { MessageBubble } from '../components/comms/MessageBubble'
import { ComposeModal } from '../components/comms/ComposeModal'
import { ContactPanel } from '../components/comms/ContactPanel'
import { ComposeBar } from '../components/comms/ComposeBar'
import { ReplySuggestion } from '../components/comms/ReplySuggestion'
import { ThreadHeader } from '../components/comms/ThreadHeader'
import { InboxLeftPanel } from '../components/comms/InboxLeftPanel'
import { InboxViewToggle } from '../components/comms/InboxViewToggle'
import { CrewInbox } from '../components/comms/CrewInbox'
import { useCommsData } from '../hooks/useCommsData'
import { useCommsMutations } from '../hooks/useCommsMutations'
import { useCommsFilters } from '../hooks/useCommsFilters'
import { useCustomerContext } from '../hooks/useCustomerContext'
import { useCompanyName } from '../hooks/useCompanyName'


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMMS PAGE
   ═══════════════════════════════════════════════════════════════════════════ */

/** Compact at-a-glance stat pill for the page header — echoes the stat row
 *  on the Home "Messages" pillar so the two surfaces read as one system. */
function HeaderStat({ n, label, tone }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-[13px] text-ink-3">
      <span className={`font-semibold tabular-nums ${tone || 'text-ink'}`}>{n}</span>
      <span className="text-[11px] text-ink-3">{label}</span>
    </span>
  )
}

export default function Comms() {
  const navigate = useNavigate()
  // ──────── Filter state ────────
  // Phase 8 IA: 3 folders + additive chip filters. Old `filter` state name
  // kept for minimal diff; values renamed. State stays inline (small) so the
  // data hook and filter-config hook can share it without a circular dep.
  const [folder, setFolder] = useState('active')
  const [chipFilters, setChipFilters] = useState(() => new Set())
  const [channelFilter, setChannelFilter] = useState('')
  // Pre-fill search from ?q= so deep links from Requests, Client detail,
  // etc. land on the right contact. Falls back to '' when the param is
  // absent — same behavior as before.
  const [urlParams, setUrlParams] = useSearchParams()
  const [search, setSearch] = useState(() => urlParams.get('q') || '')
  // React Router keeps this component mounted across same-route
  // navigations (e.g. /comms?q=alice -> /comms via a sidebar link), so
  // the useState initializer above only runs once. Re-sync `search`
  // whenever the URL's q actually changes so a stale contact filter
  // doesn't linger after the query disappears from the URL (Codex
  // review on #530). Typing in the search box doesn't touch the URL, so
  // this doesn't fight the user's own edits.
  useEffect(() => {
    setSearch(urlParams.get('q') || '')
  }, [urlParams])

  // Clients | Crew view. Crew = the office side of every cleaner's chat
  // thread, first-class inside Messages (owner: "chat with crew front and
  // center"). Kept in the URL (?view=crew) so the Crew page and mobile nav
  // can deep-link straight to it, and Back returns to the client inbox.
  const view = urlParams.get('view') === 'crew' ? 'crew' : 'inbox'
  const setView = useCallback((v) => {
    const next = new URLSearchParams(urlParams)
    if (v === 'crew') next.set('view', 'crew')
    else next.delete('view')
    setUrlParams(next, { replace: true })
  }, [urlParams, setUrlParams])

  // ──────── Data ────────

  const {
    convs, summary,
    selectedId, setSelectedId,
    detail, loadingDetail, loadingList, clients,
    threadRef,
    loadList, loadSummary, loadDetail,
  } = useCommsData({ folder, chipFilters, channelFilter, search, enabled: view !== 'crew' })

  // ──────── Filter config (memos over summary + state) ────────

  const { channelCount, FOLDERS, CHIPS, toggleChip } = useCommsFilters({
    summary, channelFilter, setChipFilters,
  })

  // Customer-360 aggregate, owned here so BOTH the contact panel and the
  // composer can use it — the panel renders appointments, the composer offers
  // appointment-aware quick-replies (reminders/confirmations) from the same
  // data. Keyed on the open thread's client.
  const customerCtx = useCustomerContext(detail?.client?.id)
  const companyName = useCompanyName()

  const [reply, setReply] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(null)

  const [showCompose, setShowCompose] = useState(false)
  // Deep-link entry: /comms?compose=1 (from the header's "+ New → New
  // message" action) opens the composer straight away, then strips the flag
  // so a refresh or back-nav doesn't reopen it.
  useEffect(() => {
    if (urlParams.get('compose') === '1') {
      setShowCompose(true)
      const next = new URLSearchParams(urlParams)
      next.delete('compose')
      setUrlParams(next, { replace: true })
    }
  }, [urlParams, setUrlParams])
  const [showContactPanel, setShowContactPanel] = useState(true)
  const [mobileView, setMobileView] = useState('list') // list | thread
  const [toast, setToast] = useState(null) // { ok: bool, msg: string }
  const showToast = useCallback((msg, ok = true) => {
    setToast({ ok, msg })
    setTimeout(() => setToast(null), ok ? 2500 : 5000)
  }, [])

  // ──────── Actions ────────

  const { setAssignee, assignUser, setStatus, setPriority, sendReplyOrNote } = useCommsMutations({
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

  const [draftingAI, setDraftingAI] = useState(false)
  const draftWithAI = async () => {
    if (!detail?.id || draftingAI) return
    setDraftingAI(true)
    try {
      const res = await post(`/api/ai/draft-conversation-reply/${detail.id}`, {})
      if (res?.message) {
        setReply(res.message)
        if (detail.channel === 'email' && res.subject) setReplySubject(res.subject)
        setFlash({ ok: true, msg: 'Drafted — edit & send' })
      } else { setFlash({ ok: false, msg: 'Could not draft a reply' }) }
    } catch { setFlash({ ok: false, msg: 'Could not draft a reply' }) }
    setDraftingAI(false)
    setTimeout(() => setFlash(null), 3000)
  }

  // Turn this conversation into a quote: the AI reads the thread, extracts the
  // service/size/location the customer described, prices it with the same
  // engine the website uses, and we hand that off to the quote form pre-filled.
  const [draftingQuote, setDraftingQuote] = useState(false)
  const draftQuote = async () => {
    if (!detail?.id || draftingQuote) return
    setDraftingQuote(true)
    try {
      const intake = await post(`/api/ai/quote-from-conversation/${detail.id}`, {})
      if (intake?.error) {
        setFlash({ ok: false, msg: intake.error })
      } else {
        navigate('/billing?view=quotes', { state: { openNewFromIntake: intake } })
      }
    } catch (e) {
      setFlash({ ok: false, msg: 'Could not draft a quote' })
    }
    setDraftingQuote(false)
    setTimeout(() => setFlash(null), 3000)
  }

  const selectConversation = (id) => {
    setSelectedId(id)
    setMobileView('thread')
  }

  // Load a ready-to-send message into the composer (replacing any draft) and
  // make sure it's visible: reply mode on, thread pane up on mobile. Powers
  // the appointment-aware quick-replies and the per-appointment "remind" bell.
  const fillReply = useCallback((text) => {
    if (!text) return
    setNoteMode(false)
    setReply(text)
    setMobileView('thread')
  }, [])

  // Manually remind the customer of a specific upcoming appointment — one tap
  // drafts an SMS with the real date/time and their first name.
  const remindAppt = useCallback((job) => {
    fillReply(apptReminderText({ job, firstName: firstNameOf(detail), company: companyName }))
  }, [fillReply, detail, companyName])

  // ──────── List-row (swipe) actions ────────
  // These act on any conversation by id — not just the open thread — so a
  // swipe on a row in the list can resolve / reopen / assign without first
  // opening it. Each hits the same endpoints the thread controls use, then
  // refreshes the list + folder counts. Best-effort with a toast on failure.
  const rowAction = useCallback(async (id, path, body, okMsg) => {
    try {
      await post(`/api/comms/conversations/${id}/${path}`, body)
      await loadList()
      await loadSummary()
      if (okMsg) showToast(okMsg)
    } catch (e) {
      showToast(String(e?.message || 'Action failed'), false)
    }
  }, [loadList, loadSummary, showToast])

  // Link an unknown-sender thread to a client (Twenty-style merge). Posts to the
  // link-client endpoint, then refreshes the open thread + list + counts so the
  // contact panel flips from "Link to a client" to the full profile immediately.
  const [linkingClient, setLinkingClient] = useState(false)
  const linkClient = useCallback(async (client) => {
    if (!detail?.id || !client?.id) return
    setLinkingClient(true)
    try {
      await post(`/api/comms/conversations/${detail.id}/link-client`, { client_id: client.id })
      await Promise.all([loadDetail(detail.id), loadList(), loadSummary()])
      showToast(`Linked to ${client.name}`)
    } catch (e) {
      showToast(String(e?.message || 'Could not link client'), false)
    } finally {
      setLinkingClient(false)
    }
  }, [detail?.id, loadDetail, loadList, loadSummary, showToast])

  const resolveConv = useCallback((id) => rowAction(id, 'status', { status: 'resolved' }, 'Marked done'), [rowAction])
  const reopenConv = useCallback((id) => rowAction(id, 'status', { status: 'open' }, 'Reopened'), [rowAction])
  const assignMine = useCallback((id) => {
    const me = JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Me'
    return rowAction(id, 'assign', { assignee: me }, `Assigned to ${me}`)
  }, [rowAction])

  // ──────── Reply co-pilot ────────
  // The last real (non-note) message decides whether the thread is "waiting
  // on us": inbound = the customer spoke last, so offer a suggested reply.
  // Direction comes from Message.direction ('inbound' | 'outbound') — the
  // same field MessageBubble aligns bubbles with.
  const lastMsg = useMemo(() => {
    const msgs = (detail?.messages || []).filter(m => !m.is_internal_note)
    return msgs.length ? msgs[msgs.length - 1] : null
  }, [detail?.messages])
  const showSuggestion = !!detail && detail.status !== 'resolved' &&
    lastMsg?.direction === 'inbound' && !noteMode

  // "Use" fills the composer exactly like Draft-with-AI does — reply mode on,
  // subject only for email threads. Never sends.
  const useSuggestion = useCallback((text, subject) => {
    setNoteMode(false)
    setReply(text)
    if (detail?.channel === 'email' && subject) setReplySubject(subject)
  }, [detail?.channel])

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

  // The Clients | Crew switch lives in the left panel header of BOTH views so
  // it never moves. Unread counts: client convs from the summary poll, crew
  // threads from the same endpoint's crew_unread_threads.
  const viewToggle = (
    <InboxViewToggle
      view={view}
      onChange={setView}
      clientUnread={summary.unread || 0}
      crewUnread={summary.crew_unread_threads || 0}
    />
  )

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Compact header — PageHeader isn't full-height on its own, and this
          three-pane inbox needs every remaining pixel, so we skip the
          subtitle and tighten the vertical padding rather than push the
          list/thread/contact columns below the fold. */}
      {/* Hidden on mobile: the list already shows "Inbox" and each thread has
          its own header, so this outer title is pure wasted top space on a
          phone. Desktop keeps it for page context. */}
      <PageHeader
        title="Messages"
        icon={MessageSquare}
        iconColor="blue"
        className="hidden lg:block pt-4 pb-3 sm:pt-4 sm:pb-3 shrink-0"
        actions={
          <div className="flex items-center gap-2">
            <HeaderStat n={summary.open || 0} label="active" />
            <HeaderStat n={summary.unread || 0} label="unread" tone={summary.unread > 0 ? 'text-indigo-600 dark:text-indigo-300' : undefined} />
            <HeaderStat n={summary.breached || 0} label="past SLA" tone={summary.breached > 0 ? 'text-red-600 dark:text-red-300' : undefined} />
          </div>
        }
      />

    {view === 'crew' ? (
      <CrewInbox viewToggle={viewToggle} />
    ) : (
    <div className="flex flex-1 min-h-0">

      <InboxLeftPanel
        header={viewToggle}
        convs={convs}
        loadingList={loadingList}
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
        onResolve={resolveConv}
        onReopen={reopenConv}
        onAssignMine={assignMine}
      />


      {/* ═══ CENTER PANEL: Thread View ═══ */}
      {/* Mobile shows exactly one pane at a time: list / thread / contact.
          On lg+ the thread is always visible alongside the list. */}
      <div className={`flex-1 flex flex-col min-w-0 ${mobileView === 'thread' ? 'flex' : 'hidden lg:flex'}`}>
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
                className="text-[13px] font-semibold text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/15 px-5 py-2.5 rounded-xl transition-colors inline-flex items-center gap-1.5">
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
              onAssign={assignUser}
            />

            {/* Messages thread */}
            <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 bg-bg/50">
              {loadingDetail && (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-hairline border-t-indigo-600 rounded-full animate-spin" />
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

            {showSuggestion && (
              <div className="border-t border-hairline bg-panel px-4 pt-3">
                <ReplySuggestion
                  conversationId={detail.id}
                  lastMessageId={lastMsg.id}
                  onUse={useSuggestion}
                />
              </div>
            )}

            <ComposeBar
              detail={detail}
              reply={reply} setReply={setReply}
              replySubject={replySubject} setReplySubject={setReplySubject}
              noteMode={noteMode} setNoteMode={setNoteMode}
              sending={sending}
              flash={flash}
              onSend={sendReply}
              onDraftAI={draftWithAI}
              draftingAI={draftingAI}
              nextAppt={customerCtx.upcomingJobs?.[0]}
              firstName={firstNameOf(detail)}
              companyName={companyName}
              onFillReply={fillReply}
            />
          </>
        )}
      </div>


      {/* ═══ RIGHT PANEL: Contact Detail ═══ */}
      {/* Shown inline on desktop (showContactPanel) or as a full-screen pane on
          mobile (mobileView==='contact'). Previously xl-only, so the "Draft a
          quote", profile, and open-items links were unreachable on a phone. */}
      {detail && (showContactPanel || mobileView === 'contact') && (
        <ContactPanel
          detail={detail}
          context={customerCtx}
          onRemind={remindAppt}
          mobileActive={mobileView === 'contact'}
          desktopOpen={showContactPanel}
          onBack={() => setMobileView('thread')}
          onAssign={setAssignee}
          onPriority={setPriority}
          onStatus={setStatus}
          onClose={() => setShowContactPanel(false)}
          onDraftQuote={draftQuote}
          draftingQuote={draftingQuote}
          onLinkClient={linkClient}
          linkingClient={linkingClient}
        />
      )}

    </div>
    )}

      {/* ═══ Compose Modal ═══ (fixed overlay — lives outside the 3-pane row) */}
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
            : 'bg-panel border-hairline text-ink-2'
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
