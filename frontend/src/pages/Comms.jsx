/**
 * Messages — the unified inbox. (File still named Comms.jsx; the route is
 * still /comms. Both are internal names — every label the operator reads says
 * "Messages".)
 *
 * Design references: Twenty CRM (clean panels, record detail, timeline),
 * Fieldcamp.io (unified profile, single-screen visibility, command center).
 *
 * ## The three panes, and which one yields
 *
 *   Left   — filter tabs + conversation list (searchable, channel-filtered)
 *   Center — thread view with day separators + compose bar
 *   Right  — customer detail + activity timeline + quick actions
 *
 * Only xl: (1280) fits all three. Below that there is room for two, and the
 * THREAD is never one of the two that goes: it is what the operator is doing.
 * So in the 900–1280 band — which includes the owner's ~940px window — opening
 * the customer column collapses the LIST (InboxLeftPanel's `hiddenForContact`),
 * and closing it brings the list back. Phones show exactly one pane at a time,
 * driven by `mobileView`.
 *
 * `showContactPanel` is the open/closed flag for that column, defaulted from a
 * one-shot xl: media query so first paint at 940px lands on list + thread.
 * Resizing is handled in CSS, not by re-reading that flag.
 *
 * ## Not here, despite what this header used to claim
 *
 * There is no keyboard-shortcuts panel and no j/k list navigation — the header
 * advertised one for a long time and nothing in the page ever bound a key
 * beyond Cmd/Ctrl+Enter to send (ComposeBar) and Enter/Space to select a row
 * (ConvItem). Likewise there are no illustrated empty states; they are an icon
 * in a bordered square. Said plainly because a docstring that describes
 * features the page lacks is how a reader ends up looking for the bug in the
 * wrong file.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  MessageSquare,
  CheckCircle2, AlertTriangle,
  MessageCircle, PenLine,
} from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import { get, post } from '../api'
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
import { ShortcutsSheet } from '../components/comms/ShortcutsSheet'
import { CrewInbox } from '../components/comms/CrewInbox'
import { useCommsData } from '../hooks/useCommsData'
import { useCommsMutations } from '../hooks/useCommsMutations'
import { useCommsFilters } from '../hooks/useCommsFilters'
import { useInboxShortcuts } from '../hooks/useInboxShortcuts'
import { useCustomerContext } from '../hooks/useCustomerContext'
import { useCompanyName } from '../hooks/useCompanyName'
import { STATUS_DOT } from '../theme/statusDots'
import { STATUS_ICON } from '../theme/statusText'


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMMS PAGE
   ═══════════════════════════════════════════════════════════════════════════ */

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
  // Open by default only where all three columns fit at once (xl:). The
  // customer panel is now a real column from shell: up, and between shell:
  // and xl: it takes the conversation list's slot — so defaulting it open
  // would hide the list, the primary triage surface, on first paint at the
  // owner's ~940px window. Read once; this is a first-paint default, not a
  // live layout subscription (resizing is handled by CSS, not by this flag).
  const [showContactPanel, setShowContactPanel] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 1280px)')?.matches,
  )
  const [mobileView, setMobileView] = useState('list') // list | thread | contact

  // Below shell: the customer panel is a full-screen pane, so the mobile view
  // has to travel with it; at shell:+ it's a column and mobileView is inert.
  // Keeping the two in step in ONE place is what stops the panel being "open"
  // (list collapsed) while nothing is on screen to show for it.
  const toggleContactPanel = useCallback(() => {
    const opening = !showContactPanel
    setShowContactPanel(opening)
    setMobileView(opening ? 'contact' : 'thread')
  }, [showContactPanel])

  // Deep-link entry: /comms?conversation=123 (from the Home board's "Reply"
  // action, or any other page) opens that specific thread directly instead
  // of landing on the bare inbox list — previously the board sent no id at
  // all, so "Reply" always dropped the owner on the list (BB-CODE-03).
  // setSelectedId alone is enough: useCommsData's selection effect fetches
  // the detail for us.
  useEffect(() => {
    const convParam = urlParams.get('conversation')
    if (convParam) {
      setSelectedId(Number(convParam))
      setMobileView('thread')
      const next = new URLSearchParams(urlParams)
      next.delete('conversation')
      setUrlParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams])
  const [toast, setToast] = useState(null) // { ok: bool, msg: string }
  const showToast = useCallback((msg, ok = true) => {
    setToast({ ok, msg })
    setTimeout(() => setToast(null), ok ? 2500 : 5000)
  }, [])

  // ──────── Actions ────────

  const { setAssignee, assignUser, setStatus, setPriority, sendReplyOrNote } = useCommsMutations({
    detail, loadDetail, loadList, loadSummary,
  })

  // Teammates who can be @mentioned in an internal note (office + crew/subs).
  // Fetched once; the composer filters this list as you type @.
  const [mentionables, setMentionables] = useState([])
  useEffect(() => {
    get('/api/comms/assignees').then(rows => setMentionables(rows || [])).catch(() => {})
  }, [])

  const sendReply = async (mentions) => {
    if (!reply.trim() || !detail) return
    setSending(true); setFlash(null)
    try {
      await sendReplyOrNote({ body: reply, subject: replySubject, isNote: noteMode, mentions })
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
      if (res?.fallback) {
        // The endpoint answers 200 with canned filler when the model can't be
        // reached. Dropping that into the composer under "Drafted — edit &
        // send" is how generic boilerplate ends up one tap from a customer
        // who asked a specific question. Say which failure it was: a missing
        // key needs someone to go set one, a failed call usually just needs
        // another try.
        setFlash({
          ok: false,
          msg: res.fallback === 'unconfigured'
            ? 'AI drafting isn’t set up yet'
            : 'Couldn’t draft a reply — try again',
        })
      } else if (res?.message) {
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
        navigate('/quotes', { state: { openNewFromIntake: intake } })
      }
    } catch (e) {
      setFlash({ ok: false, msg: 'Could not draft a quote' })
    }
    setDraftingQuote(false)
    setTimeout(() => setFlash(null), 3000)
  }

  // Memoized because useInboxShortcuts takes it as a dep: `reply` is state on
  // this page, so Comms re-renders on every character typed into the composer,
  // and an unmemoized callback would tear down and re-add the document
  // keydown listener once per keystroke.
  const selectConversation = useCallback((id) => {
    setSelectedId(id)
    setMobileView('thread')
  }, [setSelectedId])

  // Load a ready-to-send message into the composer (replacing any draft) and
  // make sure it's visible: reply mode on, thread pane up on mobile. Powers
  // the appointment-aware quick-replies and the per-appointment "remind" bell.
  //
  // Closing the customer panel is part of "make it visible", and it is the one
  // setMobileView('thread') site that needs to be: the per-appointment bell
  // lives INSIDE ContactPanel, so on a phone this fires while the customer
  // pane is the pane on screen. Leaving the flag set hid the pane but left the
  // header reading "Hide customer details", so the next tap spent itself
  // clearing a stale flag and the operator had to tap twice to reopen (codex
  // P2 on #1152 — my own change created it by coupling the flag to mobileView).
  //
  // The other three sites do NOT need it, and the reasoning is reachability
  // rather than taste: selectConversation needs a list row, ComposeModal needs
  // the composer, and the ?conversation= effect needs a fresh navigation —
  // none of those is reachable while the customer pane covers a phone screen.
  // Clearing the flag there would instead close the customer COLUMN at shell:+
  // every time a conversation is picked, which is a regression, not a fix.
  //
  // At shell:+ this closes the column too, which is a deliberate trade: the
  // alternative is reading the viewport width in an event handler, and one
  // honest source of truth for "is the panel open" is worth more than keeping
  // the column up after you've taken what you needed from it.
  const fillReply = useCallback((text) => {
    if (!text) return
    setNoteMode(false)
    setReply(text)
    setShowContactPanel(false)
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
      // The response is the KEEPER, and its id is not always the one we posted
      // about: when the client already had a thread, the server folds the two
      // and deletes the emptied shell (#1105 left this as a known gap — a
      // client could hold two threads while the person-keyed lookup showed
      // one). Reloading `detail.id` here would land on a conversation that no
      // longer exists, straight after a successful link.
      const keeper = await post(`/api/comms/conversations/${detail.id}/link-client`,
        { client_id: client.id })
      const keeperId = keeper?.id ?? detail.id
      // Move the list selection too, or the highlighted row is the dead one.
      if (keeperId !== detail.id) setSelectedId(keeperId)
      await Promise.all([loadDetail(keeperId), loadList(), loadSummary()])
      showToast(`Linked to ${client.name}`)
    } catch (e) {
      showToast(String(e?.message || 'Could not link client'), false)
    } finally {
      setLinkingClient(false)
    }
  }, [detail?.id, loadDetail, loadList, loadSummary, setSelectedId, showToast])

  const resolveConv = useCallback((id) => rowAction(id, 'status', { status: 'resolved' }, 'Marked done'), [rowAction])
  const reopenConv = useCallback((id) => rowAction(id, 'status', { status: 'open' }, 'Reopened'), [rowAction])
  const assignMine = useCallback((id) => {
    const me = JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Me'
    return rowAction(id, 'assign', { assignee: me }, `Assigned to ${me}`)
  }, [rowAction])

  // ──────── Keyboard ────────
  // j/k to move, e to close, / to search, ? for the list. The page's docstring
  // advertised a shortcuts panel for a long time and nothing in it ever bound a
  // key beyond Cmd/Ctrl+Enter; #1152 deleted that claim, this makes it true.
  // `useInboxShortcuts` owns the guards (typing targets, modifier chords) and
  // documents what it refuses to bind and why.
  const [showShortcuts, setShowShortcuts] = useState(false)
  const searchRef = useRef(null)
  const focusSearch = useCallback(() => {
    const el = searchRef.current
    if (!el) return
    // `focus()` on an element inside a `display:none` subtree does nothing,
    // and `/` has already swallowed the keystroke — so the shortcut looked
    // broken in the two states where the list is hidden: on a phone with a
    // thread open (mobileView === 'thread'), and in the 900–1280 band while
    // the customer column holds the list's slot (#1152's hiddenForContact,
    // so this one is my own doing). Reveal the list, then focus on the next
    // frame once it has painted.
    //
    // offsetParent is null for a hidden element, which is the cheap layout
    // question to ask here — and it means at xl:, where the list is always
    // up, `/` focuses directly and changes no other state. (jsdom does no
    // layout, so offsetParent is null there always: a render test only ever
    // exercises the reveal path, which is the path worth testing anyway.)
    const select = () => {
      const node = searchRef.current
      node?.focus()
      // Select what's there so `/` then typing replaces the old query rather
      // than appending to it — what you almost always want from a search box
      // you just jumped back into.
      node?.select?.()
    }
    if (el.offsetParent !== null) { select(); return }
    setMobileView('list')
    setShowContactPanel(false)
    requestAnimationFrame(select)
  }, [])

  // `e` acts on the OPEN thread, so it owes the open pane a refresh.
  // `rowAction` reloads the list and the folder counts but never the detail,
  // which is right for a swipe on a row you are not reading. Used from the
  // keyboard it left the thread pane showing the conversation as active —
  // "Mark done" still offered, reply suggestion still up — for as long as
  // sixty seconds while the toast said it was done (codex P2 on #1155).
  //
  // It ADDS the detail reload rather than switching to `setStatus`, which was
  // the first fix and was worse: `setStatus` has no try/catch and no toast, so
  // routing the shortcut through it silently dropped the "Marked done"
  // confirmation and turned any network or server failure into an unhandled
  // rejection with nothing on screen (codex again, on the fix). Trading a
  // stale pane for a swallowed error is not a fix, and the giveaway was right
  // there in my own comment: it cited the toast while removing it.
  //
  // The reload runs even when the POST failed — rowAction catches and toasts,
  // so control returns here either way. That is the behaviour worth having:
  // on failure the pane re-syncs to the truth instead of keeping whatever it
  // was showing.
  const resolveSelected = useCallback(async (id) => {
    await rowAction(id, 'status', { status: 'resolved' }, 'Marked done')
    if (id === detail?.id) await loadDetail(id)
  }, [rowAction, detail?.id, loadDetail])
  const toggleShortcuts = useCallback(() => setShowShortcuts(v => !v), [])
  const closeShortcuts = useCallback(() => setShowShortcuts(false), [])
  useInboxShortcuts({
    // Not in the crew inbox (its own list, its own selection), and not behind
    // the compose modal — j/k would move the inbox selection out of sight
    // underneath it, and the sheet is a dialog that owns the keyboard while up.
    enabled: view !== 'crew' && !showCompose && !showShortcuts,
    convs,
    selectedId,
    onSelect: selectConversation,
    onResolve: resolveSelected,
    onFocusSearch: focusSearch,
    onToggleHelp: toggleShortcuts,
  })

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
      // A change of AUTHOR starts a new group too. MessageBubble renders
      // `m.author` only on the first message of a group, so without this two
      // consecutive outbound messages sent by different teammates showed one
      // name and the second sender was unidentifiable — the thread quietly
      // carried less authorship than the activity feed #1156 deleted, which
      // labelled every message. Found by codex on #1156, after that PR had
      // merged: six of its cases were written to prove the thread is a strict
      // superset of the feed, and the author case among them only ever
      // rendered ONE message, so the boundary this fixes was never exercised.
      const isFirst = !prev || prev.direction !== m.direction || prev.is_internal_note !== m.is_internal_note ||
        (prev.author || '') !== (m.author || '') ||
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
      {/* No at-a-glance stat trio here: it re-printed counts the inbox already
          carries at rest — "active" duplicates the always-visible Active folder
          tab, "unread" duplicates the Clients|Crew toggle's unread dot. The one
          number that isn't shown anywhere at rest, and is the single most urgent
          triage, is "past SLA" — so it stays, once, as an OPERABLE jump: click
          to drop into Active + the Overdue filter. Renders nothing when nothing
          is late (no all-clear furniture). (Page-polish sweep 3/4; cf. #1042.) */}
      <PageHeader
        title="Messages"
        icon={MessageSquare}
        className="hidden shell:block pt-4 pb-3 sm:pt-4 sm:pb-3 shrink-0"
        actions={summary.breached > 0 ? (
          <button
            onClick={() => { setFolder('active'); setChipFilters(new Set(['overdue'])) }}
            title="Show conversations past their reply SLA"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 transition-colors">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT.problem} shrink-0`} aria-hidden="true" />
            <span className="font-semibold tabular-nums text-ink">{summary.breached}</span>
            <span className="text-ink-3">past SLA</span>
          </button>
        ) : undefined}
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
        hiddenForContact={!!detail && showContactPanel}
        searchRef={searchRef}
      />


      {/* ═══ CENTER PANEL: Thread View ═══ */}
      {/* Below shell: one pane at a time (list / thread / contact). At shell+
          (the owner's ~940px window) the thread sits beside the list — the
          two-pane inbox. The breakpoint was lg: (1024), so at 940px the desktop
          layout never engaged and the inbox rendered as the cramped phone view. */}
      <div className={`flex-1 flex flex-col min-w-0 ${mobileView === 'thread' ? 'flex' : 'hidden shell:flex'}`}>
        {!detail ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center bg-bg/50">
            <div className="text-center max-w-xs">
              <div className="w-20 h-20 rounded-lg bg-panel border border-hairline flex items-center justify-center mx-auto mb-5 shadow-xs">
                <MessageSquare className="w-10 h-10 text-ink-3" />
              </div>
              <h2 className="text-base font-bold text-ink-2 mb-2">Select a conversation</h2>
              <p className="text-[13px] text-ink-3 leading-relaxed mb-4">
                Choose from the list to read and reply, or start a new conversation.
              </p>
              <button onClick={() => setShowCompose(true)}
                className="text-[13px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-5 py-2.5 rounded-md transition-colors inline-flex items-center gap-1.5">
                <PenLine className="w-4 h-4" /> Compose
              </button>
            </div>
          </div>
        ) : (
          <>
            <ThreadHeader
              detail={detail}
              setMobileView={setMobileView}
              onToggleContact={toggleContactPanel}
              contactOpen={showContactPanel}
              onToggleStatus={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
              onAssign={assignUser}
            />

            {/* Messages thread */}
            {/* Padding lives on the inner wrapper, not the scroller, so
                `min-h-full` resolves to exactly the visible height (border-box)
                and doesn't force a permanent scrollbar. Messages sit at the
                BOTTOM and grow upward — `justify-end` on the inner wrapper, not
                on the scrolling element (that breaks scroll-up in some browsers
                once content overflows). max-w-3xl keeps the conversation at a
                readable measure on a wide monitor; it's a max, so phones and
                the ~940px shell are unaffected. */}
            <div ref={threadRef} className="flex-1 overflow-y-auto bg-bg/50">
              <div className="min-h-full flex flex-col justify-end px-5 py-3 mx-auto w-full max-w-3xl">
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
                  <div className="flex flex-col items-center justify-center py-8">
                    <div className="w-12 h-12 rounded-lg bg-panel border border-hairline flex items-center justify-center mb-3 shadow-xs">
                      <MessageCircle className="w-6 h-6 text-ink-3" />
                    </div>
                    <p className="text-[13px] text-ink-3">No messages yet. Start the conversation below.</p>
                  </div>
                )}
              </div>
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
              mentionables={mentionables}
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


      {/* ═══ RIGHT PANEL: Customer ═══ */}
      {/* An inline column from shell: up, a full-screen pane only on phones.
          Both exits (the mobile back arrow, the panel's own ✕) go through
          toggleContactPanel so the flag and mobileView can't drift apart —
          leaving the flag true after a back-out would keep the conversation
          list collapsed in the 900–1280 band with nothing in its place. */}
      {detail && (showContactPanel || mobileView === 'contact') && (
        <ContactPanel
          detail={detail}
          context={customerCtx}
          onRemind={remindAppt}
          mobileActive={mobileView === 'contact'}
          desktopOpen={showContactPanel}
          onBack={toggleContactPanel}
          onAssign={setAssignee}
          onPriority={setPriority}
          onStatus={setStatus}
          onClose={toggleContactPanel}
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


      <ShortcutsSheet open={showShortcuts} onClose={closeShortcuts} />

      {/* ═══ Agent Widget ═══ */}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-60 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg border text-sm ${
          toast.ok
            ? 'bg-panel border-hairline text-ink'
            : 'bg-panel border-hairline text-ink-2'
        }`}>
          {toast.ok
            ? <CheckCircle2 className={`w-4 h-4 ${STATUS_ICON.ok} shrink-0`} />
            : <AlertTriangle className={`w-4 h-4 ${STATUS_ICON.attention} shrink-0`} />}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  )
}
