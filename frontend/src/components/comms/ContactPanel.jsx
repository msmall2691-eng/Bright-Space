import { useMemo } from 'react'
import { X, Phone, Mail, MapPin, User, Hash, StickyNote, ArrowLeft, Send, FileText, Loader2 } from 'lucide-react'
import { formatPhone } from '../../utils/display'
import { contactDisplay, relTime } from './utils'
import { Avatar, ChannelBadge } from './primitives'
import RecordLink from '../RecordLink'
import AiInsight from '../AiInsight'
import { LinkClientControl } from './LinkClientControl'
import { useClientQuickLinks } from '../../hooks/useClientQuickLinks'

/** Right-side contact detail panel: summary header (avatar, status,
 *  channel badge, click-to-call/email links, address, "View Full Profile"),
 *  tags row, and a 15-item activity timeline synthesized from the thread's
 *  messages. The Assignee/Priority/Status block was retired in Phase 8. */
export function ContactPanel({ detail, onAssign, onPriority, onStatus, onClose, onDraftQuote, draftingQuote, onLinkClient, linkingClient, mobileActive, desktopOpen, onBack }) {
  if (!detail) return null
  const name = contactDisplay(detail)
  const client = detail.client
  const { openQuotes, upcomingJobs, unpaidInvoices } = useClientQuickLinks(client?.id)

  // Build a timeline from messages
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

  return (
    <div className={`${mobileActive ? 'flex' : 'hidden'} ${desktopOpen ? 'lg:flex' : 'lg:hidden'}
      fixed inset-0 z-40 lg:static lg:inset-auto lg:z-auto
      w-full lg:w-[320px] border-l border-hairline bg-panel flex-col overflow-hidden shrink-0`}>
      {/* Mobile back bar — this pane is full-screen on a phone (< lg). */}
      <div className="lg:hidden flex items-center gap-2 px-3 h-12 border-b border-hairline shrink-0">
        <button onClick={onBack} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-2">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="text-sm font-semibold text-ink">Details</span>
      </div>
      {/* Contact header */}
      <div className="p-5 bg-bg-2 border-b border-hairline">
        <div className="flex items-start gap-3">
          <Avatar name={client?.name || detail.external_contact} size="lg" />
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-ink text-[15px] truncate leading-tight">{name}</h3>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                client?.status === 'active'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-bg-2 text-ink-3'
              }`}>
                {(client?.status || 'new').toUpperCase()}
              </span>
              <ChannelBadge channel={detail.channel} />
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-bg-2 flex items-center justify-center text-ink-3 hover:text-ink-2 transition-colors lg:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Contact info chips */}
        <div className="mt-3 space-y-1.5">
          {(client?.phone || detail.external_contact) && (
            <a href={`tel:${client?.phone || detail.external_contact}`}
              className="flex items-center gap-2 text-[12px] text-ink-2 hover:text-indigo-600 transition-colors group">
              <div className="w-6 h-6 rounded-lg bg-bg-2 group-hover:bg-indigo-500/10 flex items-center justify-center transition-colors">
                <Phone className="w-3 h-3 text-ink-3 group-hover:text-indigo-600" />
              </div>
              {formatPhone(client?.phone || detail.external_contact)}
            </a>
          )}
          {client?.email && (
            <a href={`mailto:${client.email}`}
              className="flex items-center gap-2 text-[12px] text-ink-2 hover:text-indigo-600 transition-colors group">
              <div className="w-6 h-6 rounded-lg bg-bg-2 group-hover:bg-indigo-500/10 flex items-center justify-center transition-colors">
                <Mail className="w-3 h-3 text-ink-3 group-hover:text-indigo-600" />
              </div>
              {client.email}
            </a>
          )}
          {client?.address && (
            <div className="flex items-center gap-2 text-[12px] text-ink-3">
              <div className="w-6 h-6 rounded-lg bg-bg-2 flex items-center justify-center">
                <MapPin className="w-3 h-3 text-ink-3" />
              </div>
              {client.address}
            </div>
          )}
        </div>

        {/* Turn this conversation into a quote — reads the thread, extracts the
            service/size/location the customer described, and opens the quote
            form pre-filled + priced. Works for leads with no client record yet,
            which is exactly when it's most useful. */}
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
          // Unknown-sender thread: no client yet. Offer the "link to a client"
          // merge so the whole conversation attaches to the right record.
          <LinkClientControl onLink={onLinkClient} linking={linkingClient} />
        ) : null}
      </div>

      {/* Phase 8 (cleanup): removed the Assignee / Priority / Status block.
          Mark done lives in the thread header (top-right). Assign + Snooze
          will move into a "⋯" overflow menu later if anyone misses them.
          What stays here: contact summary, tags, activity timeline. */}
      <div className="overflow-y-auto flex-1">
        <div className="px-4 pt-3 space-y-4">
          {/* AI-enriched gist of the thread: what it's about + the next step. */}
          <AiInsight type="conversation" id={detail.id} />
          {/* Open items — the "linked both ways" piece: this contact panel
              used to be a dead end at phone/email/address. Surfaces the
              client's open quotes, upcoming jobs, and unpaid invoices so an
              operator mid-thread can jump straight to the record the
              conversation is actually about. */}
          {client && (openQuotes.length > 0 || upcomingJobs.length > 0 || unpaidInvoices.length > 0) && (
            <div>
              <label className="text-[10px] font-bold text-ink-3 uppercase tracking-wider block mb-1.5">Open Items</label>
              <div className="space-y-1.5">
                {upcomingJobs.map(j => (
                  <div key={`job-${j.id}`} className="flex items-center justify-between gap-2 text-[12px] bg-bg-2 rounded-lg px-2.5 py-1.5">
                    <RecordLink type="job" id={j.id} label={j.title} icon className="min-w-0" />
                    <span className="text-[10px] text-ink-3 shrink-0">{j.scheduled_date}</span>
                  </div>
                ))}
                {openQuotes.map(q => (
                  <div key={`quote-${q.id}`} className="flex items-center justify-between gap-2 text-[12px] bg-bg-2 rounded-lg px-2.5 py-1.5">
                    <RecordLink type="quote" id={q.id} label={`$${q.total?.toFixed(2)} quote`} icon className="min-w-0" />
                    <span className="text-[10px] text-ink-3 shrink-0 capitalize">{(q.status || '').replace('_', ' ')}</span>
                  </div>
                ))}
                {unpaidInvoices.map(inv => (
                  <div key={`inv-${inv.id}`} className="flex items-center justify-between gap-2 text-[12px] bg-bg-2 rounded-lg px-2.5 py-1.5">
                    <RecordLink type="invoice" id={inv.id} label={inv.invoice_number} icon className="min-w-0" />
                    <span className="text-[10px] text-red-500 font-medium shrink-0">${inv.total?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {detail.tags?.length > 0 && (
            <div>
              <label className="text-[10px] font-bold text-ink-3 uppercase tracking-wider block mb-1.5">Tags</label>
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

        {/* Activity Timeline — Fieldcamp-inspired */}
        <div className="p-4">
          <label className="text-[10px] font-bold text-ink-3 uppercase tracking-wider block mb-3">
            Activity Timeline
          </label>
          {timeline.length === 0 ? (
            <div className="text-[12px] text-ink-3 text-center py-4">No activity yet</div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
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
