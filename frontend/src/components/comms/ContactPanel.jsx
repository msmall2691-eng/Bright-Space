import { useMemo } from 'react'
import {
  X, Phone, Mail, MapPin, User, Hash, StickyNote, ArrowLeft, Send, FileText, Loader2,
  MessageSquare, Calendar, CheckCircle2, RefreshCw, DollarSign, BellRing,
} from 'lucide-react'
import { formatDate, combineAddress, formatAddress } from '../../utils/format'
import { contactDisplay, relTime } from './utils'
import { Avatar, ChannelBadge } from './primitives'
import RecordLink from '../RecordLink'
import AiInsight from '../AiInsight'
import { LinkClientControl } from './LinkClientControl'

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
  return (
    <div className="flex items-center justify-between gap-2 bg-bg-2 rounded-lg px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
          tone === 'upcoming' ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'bg-bg-2 text-ink-3'
        }`}>
          {tone === 'upcoming' ? <Calendar className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
        </div>
        <div className="min-w-0">
          <RecordLink type="job" id={job.id} label={job.title || 'Cleaning'} className="min-w-0 text-[12px]" />
          <div className="text-[10px] text-ink-3 truncate">
            {dateLabel}{time ? ` · ${time}` : ''}
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
            className="w-6 h-6 rounded-lg flex items-center justify-center text-ink-3 hover:text-indigo-600 hover:bg-indigo-500/10 transition-colors">
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

  // Activity feed from the thread's own messages (cross-channel timeline).
  const timeline = useMemo(() => {
    if (!detail.messages) return []
    return [...detail.messages]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 15)
      .map(m => ({
        id: m.id,
        type: m.is_internal_note ? 'note' : m.direction,
        channel: m.channel,
        body: (m.body || '').slice(0, 100),
        time: m.created_at,
        author: m.author || (m.direction === 'outbound' ? 'You' : name),
      }))
  }, [detail.messages, name])

  const hasMoney = openQuotes.length > 0 || unpaidInvoices.length > 0

  return (
    <div className={`${mobileActive ? 'flex' : 'hidden'} ${desktopOpen ? 'lg:flex' : 'lg:hidden'}
      fixed inset-0 z-40 lg:static lg:inset-auto lg:z-auto
      w-full lg:w-[340px] border-l border-hairline bg-panel flex-col overflow-hidden shrink-0`}>
      {/* Mobile back bar — this pane is full-screen on a phone (< lg). */}
      <div className="lg:hidden flex items-center gap-2 px-3 h-12 border-b border-hairline shrink-0">
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
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                client?.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-bg-2 text-ink-3'
              }`}>
                {(client?.status || 'new').toUpperCase()}
              </span>
              <ChannelBadge channel={detail.channel} />
              {client?.created_at && (
                <span className="text-[10px] text-ink-3">
                  Since {formatDate(client.created_at, { month: 'short', year: 'numeric' })}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3 hover:text-ink-2 transition-colors lg:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* One-tap contact actions — call / text / email in a single row so the
            operator can reach the customer any channel without hunting. */}
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone}
            className={`flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-semibold transition-colors ${
              phone ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-indigo-700 dark:hover:text-indigo-300' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <Phone className="w-3.5 h-3.5" /> Call
          </a>
          <a href={phone ? `sms:${phone}` : undefined} aria-disabled={!phone}
            className={`flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-semibold transition-colors ${
              phone ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-indigo-700 dark:hover:text-indigo-300' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <MessageSquare className="w-3.5 h-3.5" /> Text
          </a>
          <a href={client?.email ? `mailto:${client.email}` : undefined} aria-disabled={!client?.email}
            className={`flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-semibold transition-colors ${
              client?.email ? 'bg-panel border border-hairline text-ink-2 hover:bg-indigo-500/10 hover:text-indigo-700 dark:hover:text-indigo-300' : 'bg-bg-2 text-ink-3 opacity-50 pointer-events-none'
            }`}>
            <Mail className="w-3.5 h-3.5" /> Email
          </a>
        </div>

        {/* Address with map link */}
        {address && (
          <a href={mapHref} target="_blank" rel="noreferrer"
            className="mt-2 flex items-center gap-2 text-[12px] text-ink-2 hover:text-indigo-600 transition-colors group">
            <div className="w-6 h-6 rounded-lg bg-panel group-hover:bg-indigo-500/10 flex items-center justify-center transition-colors shrink-0">
              <MapPin className="w-3 h-3 text-ink-3 group-hover:text-indigo-600" />
            </div>
            <span className="truncate">{address}</span>
          </a>
        )}

        {/* Draft a quote from the thread — leads with no client record too. */}
        {onDraftQuote && (
          <button onClick={onDraftQuote} disabled={draftingQuote}
            className="mt-3 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 py-2 rounded-xl transition-all">
            {draftingQuote
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading conversation…</>
              : <><FileText className="w-3.5 h-3.5" /> Draft a quote from this</>}
          </button>
        )}

        {client ? (
          <a href={`/clients/${client.id}`}
            className="mt-2 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/15 py-2 rounded-xl transition-colors">
            <User className="w-3.5 h-3.5" /> View Full Profile
          </a>
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
                    <span className={`text-[10px] font-medium shrink-0 flex items-center gap-0.5 ${inv.status === 'overdue' ? 'text-red-500' : 'text-ink-2'}`}>
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
                  <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-bg-2 text-ink-2 px-2 py-0.5 rounded-full font-medium">
                    <Hash className="w-2.5 h-2.5" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ═══ Activity Timeline — cross-channel message feed ═══ */}
        <div className="p-4">
          <label className="text-[10px] font-bold text-ink-3 uppercase tracking-wider block mb-3">
            Conversation activity
          </label>
          {timeline.length === 0 ? (
            <div className="text-[12px] text-ink-3 text-center py-4">No activity yet</div>
          ) : (
            <div className="relative">
              <div className="absolute left-[11px] top-2 bottom-2 w-px bg-bg-2" />
              <div className="space-y-3">
                {timeline.map(item => {
                  const iconConfig = {
                    note:     { icon: StickyNote, bg: 'bg-amber-100', text: 'text-amber-600' },
                    inbound:  { icon: ArrowLeft,  bg: 'bg-bg-2',  text: 'text-ink-3' },
                    outbound: { icon: Send,       bg: 'bg-indigo-500/15',  text: 'text-indigo-600 dark:text-indigo-300' },
                  }
                  const cfg = iconConfig[item.type] || iconConfig.inbound
                  const Icon = cfg.icon
                  return (
                    <div key={item.id} className="flex items-start gap-2.5 relative">
                      <div className={`w-[22px] h-[22px] rounded-full ${cfg.bg} flex items-center justify-center shrink-0 z-10`}>
                        <Icon className={`w-3 h-3 ${cfg.text}`} />
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-ink-2">{item.author}</span>
                          {item.channel && <ChannelBadge channel={item.channel} compact />}
                          <span className="text-[10px] text-ink-3 ml-auto shrink-0">{relTime(item.time)}</span>
                        </div>
                        <p className="text-[11px] text-ink-3 mt-0.5 truncate leading-relaxed">{item.body}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
