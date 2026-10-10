import { Link } from 'react-router-dom'
import {
  X, Phone, Mail, MapPin, User, Hash, ArrowLeft, FileText, Loader2,
  MessageSquare, Calendar, CheckCircle2, RefreshCw, DollarSign, BellRing,
} from 'lucide-react'
import { formatDate, combineAddress, formatAddress } from '../../utils/format'
import { contactDisplay } from './utils'
import { Avatar, ChannelBadge } from './primitives'
import RecordLink from '../RecordLink'
import AiInsight from '../AiInsight'
import { LinkClientControl } from './LinkClientControl'
import { STATUS_DOT } from '../../theme/statusDots'
import { STATUS_TEXT } from '../../theme/statusText'

const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

/** Section heading used throughout the panel — small uppercase label with an
 *  optional trailing count/action, so every block reads as one system. */
function SectionLabel({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <label className="text-[10px] font-bold text-ink-3 uppercase tracking-wider">{children}</label>
      {right}
    </div>
  )
}

/** One appointment row — the thing the operator most wants in view while
 *  they're texting. Date + time on the left, status/recurring badge right. */
function AppointmentRow({ job, tone = 'upcoming', onRemind }) {
  const dateLabel = formatDate(job.scheduled_date, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = (job.start_time || '').slice(0, 5)
  // A past row used to draw a tick for EVERY job dated before today, whatever
  // its status — so a visit nobody closed out appeared under "Recent visits"
  // with a checkmark, asserting it happened. The one place the operator looks
  // to answer "did we go?" was answering yes on the strength of the date
  // alone. An unresolved visit gets the attention dot and says what it is.
  const unresolved = tone === 'past' && job.status !== 'completed' && job.status !== 'cancelled'
  return (
    <div className="flex items-center justify-between gap-2 bg-bg-2 rounded-lg px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-6 h-6 rounded-lg bg-panel flex items-center justify-center shrink-0 ${
          tone === 'upcoming' ? 'text-link' : 'text-ink-3'
        }`}>
          {tone === 'upcoming'
            ? <Calendar className="w-3 h-3" />
            : unresolved
              ? <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" />
              : <CheckCircle2 className="w-3 h-3" />}
        </div>
        <div className="min-w-0">
          <RecordLink type="job" id={job.id} label={job.title || 'Cleaning'} className="min-w-0 text-[12px]" />
          <div className="text-[10px] text-ink-3 truncate">
            {dateLabel}{time ? ` · ${time}` : ''}
            {/* Bare dot + word, per the design language — the dot alone would
                leave the operator to infer what it means. */}
            {unresolved && <span className={STATUS_TEXT.attention}> · not closed out</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {job.is_recurring && <RefreshCw className="w-3 h-3 text-ink-3" title="Recurring" />}
        {/* Manual "remind them of this appointment" — one tap loads a
            ready-to-send reminder SMS (with the real date/time) into the
            composer so the operator can glance, tweak, and send. */}
        {onRemind && (
          <button onClick={() => onRemind(job)} title="Text an appointment reminder"
            className="w-6 h-6 rounded-lg flex items-center justify-center text-ink-3 hover:text-link hover:bg-indigo-500/10 transition-colors">
            <BellRing className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Right-side Customer-360 panel (Twenty CRM record-detail, applied to a live
 * conversation). Top-down: identity + one-tap call/text/email, a headline stat
 * strip, the customer's UPCOMING appointments, recent visits, open money
 * (quotes + unpaid invoices), an AI gist, and the cross-channel activity feed.
 * Everything the operator needs to speak to a customer without leaving the
 * thread. All action props (onDraftQuote, onLinkClient, status/priority) are
 * unchanged from the previous panel.
 */
export function ContactPanel({ detail, context, onRemind, onClose, onDraftQuote, draftingQuote, onLinkClient, linkingClient, mobileActive, desktopOpen, onBack }) {
  if (!detail) return null
  const name = contactDisplay(detail)
  const client = detail.client
  // Customer-360 aggregate is owned by the Comms page (shared with the
  // composer for appointment-aware quick-replies); default to empty so this
  // panel still renders if a caller doesn't pass it.
  const { upcomingJobs = [], pastJobs = [], openQuotes = [], unpaidInvoices = [], stats = {} } = context || {}

  const phone = client?.phone || detail.external_contact
  const address = client && formatAddress(combineAddress(client.address, client.city, client.state, client.zip_code))
  const mapHref = address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : null

  const hasMoney = openQuotes.length > 0 || unpaidInvoices.length > 0

  return (
    <div className={`${mobileActive ? 'flex' : 'hidden'} ${desktopOpen ? 'shell:flex' : 'shell:hidden'}
      fixed inset-0 z-40 shell:static shell:inset-auto shell:z-auto
      w-full shell:w-[300px] xl:w-[340px] border-l border-hairline bg-panel flex-col overflow-hidden shrink-0`}>
      {/* A real column from shell: (900px) up; a full-screen pane only on
          phones.

          It used to become a column at xl: (1280) only, reasoning that three
          340px panes don't fit below that. The arithmetic was right and the
          conclusion was wrong. The owner's window is ~940px, so for her this
          panel was ALWAYS the full-screen overlay: every look at the next
          appointment, the money owed or "Draft a quote" closed the thread she
          was reading, and she had to back out to read it again. The thread is
          the one pane that must never be covered.
          What steps aside instead is the conversation LIST (InboxLeftPanel's
          `hiddenForContact`), so 900–1280 is always two real panes — list +
          thread, or thread + customer — and only xl: shows all three.

          The widths, measured rather than assumed, because the app shell takes
          its cut first: Sidebar is `shell:w-60` (240px), so the owner's ~940px
          window leaves the page 700px, not 940. Closed, that's list 320 +
          thread 380. Open, it's thread 400 + this column at 300 — which is why
          300 here and 340 only at xl:, where there is room for all three. The
          thread never drops below ~380px (iPhone width, and a message thread's
          natural measure); today, opening this panel left it zero. */}
      <div className="shell:hidden flex items-center gap-2 px-3 h-12 border-b border-hairline shrink-0">
        <button onClick={onBack} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-2">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="text-sm font-semibold text-ink">Customer</span>
      </div>

      {/* ═══ Identity header ═══ */}
      <div className="p-4 bg-bg-2 border-b border-hairline">
        <div className="flex items-start gap-3">
          <Avatar name={client?.name || detail.external_contact} size="lg" />
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-ink text-[15px] truncate leading-tight">{name}</h3>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-2 capitalize">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${client?.status === 'active' ? STATUS_DOT.ok : 'bg-ink-3'}`} aria-hidden="true" />
                {client?.status || 'new'}
              </span>
              <ChannelBadge channel={detail.channel} />
              {client?.created_at && (
                <span className="text-[10px] text-ink-3">
                  Since {formatDate(client.created_at, { month: 'short', year: 'numeric' })}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3 hover:text-ink-2 transition-colors shell:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* One-tap contact actions — call / text / email in a single row so the
            operator can reach the customer any channel without hunting. */}
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone}
            className={`flex flex-col items-center gap-1 py-2 rounded-md text-[11px] font-semibold transition-colors ${
              phone ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-link dark:hover:text-link' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <Phone className="w-3.5 h-3.5" /> Call
          </a>
          <a href={phone ? `sms:${phone}` : undefined} aria-disabled={!phone}
            className={`flex flex-col items-center gap-1 py-2 rounded-md text-[11px] font-semibold transition-colors ${
              phone ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-link dark:hover:text-link' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <MessageSquare className="w-3.5 h-3.5" /> Text
          </a>
          <a href={client?.email ? `mailto:${client.email}` : undefined} aria-disabled={!client?.email}
            className={`flex flex-col items-center gap-1 py-2 rounded-md text-[11px] font-semibold transition-colors ${
              client?.email ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-link dark:hover:text-link' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <Mail className="w-3.5 h-3.5" /> Email
          </a>
        </div>

        {/* Address with map link */}
        {address && (
          <a href={mapHref} target="_blank" rel="noreferrer"
            className="mt-2 flex items-center gap-2 text-[12px] text-ink-2 hover:text-link transition-colors group">
            <div className="w-6 h-6 rounded-lg bg-panel group-hover:bg-indigo-500/10 flex items-center justify-center transition-colors shrink-0">
              <MapPin className="w-3 h-3 text-ink-3 group-hover:text-link" />
            </div>
            <span className="truncate">{address}</span>
          </a>
        )}

        {/* Draft a quote from the thread — leads with no client record too. */}
        {onDraftQuote && (
          <button onClick={onDraftQuote} disabled={draftingQuote}
            className="mt-3 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 py-2 rounded-md transition-all">
            {draftingQuote
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading conversation…</>
              : <><FileText className="w-3.5 h-3.5" /> Draft a quote from this</>}
          </button>
        )}

        {client ? (
          /* Client-side <Link> (was a raw <a>, which forced a full page reload) */
          <Link to={`/clients/${client.id}`}
            className="mt-2 w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-ink-2 bg-panel border border-hairline-2 hover:bg-bg-2 py-2 rounded-md transition-colors">
            <User className="w-3.5 h-3.5" /> View full profile
          </Link>
        ) : onLinkClient ? (
          <LinkClientControl onLink={onLinkClient} linking={linkingClient} />
        ) : null}
      </div>

      <div className="overflow-y-auto flex-1">
        {/* ═══ Headline stats — only when we know the client ═══ */}
        {client && (
          <div className="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
            <div className="px-2 py-3 text-center">
              <div className="text-[15px] font-bold text-ink tabular-nums">{stats.visitCount || 0}</div>
              <div className="text-[10px] text-ink-3">visits</div>
            </div>
            <div className="px-2 py-3 text-center">
              <div className="text-[15px] font-bold text-ink tabular-nums">{money(stats.lifetimeValue)}</div>
              <div className="text-[10px] text-ink-3">lifetime</div>
            </div>
            <div className="px-2 py-3 text-center">
              <div className="text-[13px] font-bold text-ink tabular-nums truncate">
                {stats.nextServiceDate ? formatDate(stats.nextServiceDate, { month: 'short', day: 'numeric' }) : '—'}
              </div>
              <div className="text-[10px] text-ink-3">next visit</div>
            </div>
          </div>
        )}

        <div className="px-4 pt-3 space-y-4">
          {/* AI-enriched gist of the thread: what it's about + the next step. */}
          <AiInsight type="conversation" id={detail.id} />

          {/* ═══ Upcoming appointments — the headline "see their appts" block ═══ */}
          {upcomingJobs.length > 0 && (
            <div>
              <SectionLabel right={<span className="text-[10px] text-ink-3">{upcomingJobs.length}</span>}>
                Upcoming appointments
              </SectionLabel>
              <div className="space-y-1.5">
                {upcomingJobs.slice(0, 4).map(j => <AppointmentRow key={`up-${j.id}`} job={j} tone="upcoming" onRemind={detail.channel === 'sms' ? onRemind : undefined} />)}
              </div>
            </div>
          )}

          {/* ═══ Recent visits ═══ */}
          {pastJobs.length > 0 && (
            <div>
              <SectionLabel>Recent visits</SectionLabel>
              <div className="space-y-1.5">
                {pastJobs.slice(0, 3).map(j => <AppointmentRow key={`past-${j.id}`} job={j} tone="past" />)}
              </div>
            </div>
          )}

          {/* ═══ Open money — quotes awaiting + unpaid invoices ═══ */}
          {hasMoney && (
            <div>
              <SectionLabel>Money</SectionLabel>
              <div className="space-y-1.5">
                {openQuotes.map(q => (
                  <div key={`quote-${q.id}`} className="flex items-center justify-between gap-2 text-[12px] bg-bg-2 rounded-lg px-2.5 py-1.5">
                    <RecordLink type="quote" id={q.id} label={`${money(q.total)} quote`} icon className="min-w-0" />
                    <span className="text-[10px] text-ink-3 shrink-0 capitalize">{(q.status || '').replace('_', ' ')}</span>
                  </div>
                ))}
                {unpaidInvoices.map(inv => (
                  <div key={`inv-${inv.id}`} className="flex items-center justify-between gap-2 text-[12px] bg-bg-2 rounded-lg px-2.5 py-1.5">
                    <RecordLink type="invoice" id={inv.id} label={inv.invoice_number || 'Invoice'} icon className="min-w-0" />
                    <span className={`text-[10px] font-medium shrink-0 flex items-center gap-0.5 ${inv.status === 'overdue' ? STATUS_TEXT.problem : 'text-ink-2'}`}>
                      <DollarSign className="w-2.5 h-2.5" />{money(inv.total)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {detail.tags?.length > 0 && (
            <div>
              <SectionLabel>Tags</SectionLabel>
              <div className="flex flex-wrap gap-1">
                {detail.tags.map(t => (
                  <span key={t} className="inline-flex items-center gap-1 text-[11px] rounded-md border border-hairline-2 bg-panel text-ink-2 px-1.5 py-0.5 font-medium">
                    <Hash className="w-2.5 h-2.5 text-ink-3" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* The "Conversation activity" timeline that used to close this panel
            is gone. It listed the last 15 messages of THIS thread, author +
            channel + relative time + the body truncated to 100 characters —
            a strictly smaller version of the thread pane.

            #1156 justified that by saying the thread is rendered immediately
            to the left. At shell: and up, true. BELOW shell: it is NOT: this
            panel is still `fixed inset-0` and Comms hides the thread whenever
            mobileView === 'contact', so on a phone the feed was the only
            message context on screen (codex P2, correctly). The deletion still
            stands there — the thread is one tap back up the pane, and a
            100-character recap of what you just read is not worth a third of
            a phone screen you came to for appointments and money — but it is
            a judgement call, not the tautology the first comment implied.

            MessageBubble already shows the
            author, the channel, the full timestamp, the whole body with quoted
            email collapsed, AND the delivery status, which the feed never had.
            So it cost roughly a third of this panel's height to show less of
            what was already on screen; the owner has named that kind of
            duplication herself ("it's almost a little redundant").

            Deleting it lifts appointments and open money — the things you
            actually want in view while talking to someone — above the fold
            instead of below a feed of what you are already reading. The one
            thing it marked that the bubbles do not is the channel of each SMS:
            bubbles badge email and voice and leave SMS unmarked, which is the
            right encoding (mark the exceptions, not the default) and not worth
            an icon on every bubble in a thread that is usually all texts. */}
      </div>
    </div>
  )
}
