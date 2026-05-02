/**
 * Comms â Phase 3: Modern unified inbox.
 *
 * Design references: Twenty CRM (clean panels, record detail, timeline),
 * Fieldcamp.io (unified profile, single-screen visibility, command center).
 *
 * Three-pane layout:
 *   Left   â filter tabs + conversation list (searchable, channel-filtered)
 *   Center â thread view with day separators + compose bar
 *   Right  â contact detail + activity timeline + quick actions
 *
 * New in Phase 3:
 *   â¢ New conversation compose (SMS + Email)
 *   â¢ Day separators in thread view
 *   â¢ Activity timeline in contact panel (all channels in one feed)
 *   â¢ Refined visual design (Twenty/Fieldcamp-inspired)
 *   â¢ Keyboard shortcuts panel
 *   â¢ Empty states with illustrations
 *   â¢ Mobile-responsive layout
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Send, MessageSquare, Mail, Phone, Search, User, Clock,
  CheckCircle2, AlertTriangle, Circle, StickyNote, Tag as TagIcon,
  UserPlus, ChevronRight, Inbox, Archive, Pause, Flag, X,
  MoreHorizontal, ArrowLeft, Paperclip, Smile, Hash, Bell,
  Filter, Star, ChevronDown, ExternalLink, Building2, MapPin,
  PhoneCall, AtSign, Plus, Edit3, ArrowUpRight, Calendar,
  Zap, Eye, MailPlus, MessageCircle, PenLine, Sparkles,
} from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import GmailInbox from '../components/GmailInbox'
import { get, post } from "../api"


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   DESIGN TOKENS
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

const COLORS = {
  primary: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
  surface: { 0: '#ffffff', 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7' },
  ink: { 900: '#18181b', 700: '#3f3f46', 500: '#71717a', 400: '#a1a1aa', 300: '#d4d4d8' },
}

const SLA_CONFIG = {
  met:      { bg: '#ecfdf5', text: '#047857', dot: '#10b981', label: 'Met' },
  on_track: { bg: '#eff6ff', text: '#1d4ed8', dot: '#3b82f6', label: 'On track' },
  at_risk:  { bg: '#fffbeb', text: '#b45309', dot: '#f59e0b', label: 'At risk' },
  breached: { bg: '#fef2f2', text: '#b91c1c', dot: '#ef4444', label: 'Breached' },
}

const CHANNEL_CONFIG = {
  sms:      { icon: Phone,          label: 'SMS',      bg: 'bg-emerald-50',  text: 'text-emerald-700', ring: 'ring-emerald-200' },
  email:    { icon: Mail,           label: 'Email',    bg: 'bg-blue-50',     text: 'text-blue-700',    ring: 'ring-blue-200' },
  chat:     { icon: MessageSquare,  label: 'Chat',     bg: 'bg-violet-50',   text: 'text-violet-700',  ring: 'ring-violet-200' },
  whatsapp: { icon: MessageSquare,  label: 'WhatsApp', bg: 'bg-green-50',    text: 'text-green-700',   ring: 'ring-green-200' },
}

const PRIORITY_COLORS = {
  low:    { active: 'bg-zinc-100 text-zinc-600 ring-zinc-300', dot: 'bg-zinc-400' },
  normal: { active: 'bg-blue-100 text-blue-700 ring-blue-300', dot: 'bg-blue-500' },
  high:   { active: 'bg-amber-100 text-amber-700 ring-amber-300', dot: 'bg-amber-500' },
  urgent: { active: 'bg-red-100 text-red-700 ring-red-300', dot: 'bg-red-500' },
}

const TEAM_ASSIGNEES = ['Megan', 'Unassigned']


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   UTILITY FUNCTIONS
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function formatPhone(p) {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1')
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
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
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fullTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function isPhoneNumber(s) { return /^\+?\d[\d\s\-\(\)]+$/.test(s || '') }

function contactDisplay(conv) {
  const name = conv?.client?.name || conv?.external_contact || 'Unknown'
  return isPhoneNumber(name) ? formatPhone(name) : name
}


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   SHARED UI PRIMITIVES
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function Avatar({ name, size = 'md', className = '', online }) {
  const sizes = {
    xs: 'w-5 h-5 text-[9px]',
    sm: 'w-7 h-7 text-[10px]',
    md: 'w-9 h-9 text-xs',
    lg: 'w-11 h-11 text-sm',
    xl: 'w-14 h-14 text-base',
  }
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  const palettes = [
    'bg-gradient-to-br from-blue-400 to-blue-600 text-white',
    'bg-gradient-to-br from-emerald-400 to-emerald-600 text-white',
    'bg-gradient-to-br from-violet-400 to-violet-600 text-white',
    'bg-gradient-to-br from-amber-400 to-amber-600 text-white',
    'bg-gradient-to-br from-rose-400 to-rose-600 text-white',
    'bg-gradient-to-br from-cyan-400 to-cyan-600 text-white',
    'bg-gradient-to-br from-indigo-400 to-indigo-600 text-white',
    'bg-gradient-to-br from-orange-400 to-orange-600 text-white',
  ]
  const hash = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return (
    <div className={`relative shrink-0 ${className}`}>
      <div className={`${sizes[size]} rounded-full flex items-center justify-center font-semibold shadow-sm ${palettes[hash % palettes.length]}`}>
        {initials}
      </div>
      {online && (
        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />
      )}
    </div>
  )
}

function ChannelBadge({ channel, compact = false }) {
  const c = CHANNEL_CONFIG[channel] || CHANNEL_CONFIG.sms
  const Icon = c.icon
  if (compact) return <Icon className={`w-3.5 h-3.5 ${c.text}`} />
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${c.bg} ${c.text}`}>
      <Icon className="w-3 h-3" /> {c.label}
    </span>
  )
}

function SlaBadge({ state, deadline, compact = false }) {
  if (!state || state === 'none') return null
  const c = SLA_CONFIG[state] || SLA_CONFIG.on_track
  if (compact) return <span title={`SLA: ${c.label}`} className="inline-block w-2 h-2 rounded-full" style={{ background: c.dot }} />
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
      style={{ background: c.bg, color: c.text }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
      {c.label}
    </span>
  )
}

function PriorityDot({ priority }) {
  const p = PRIORITY_COLORS[priority]
  if (!p) return null
  return <span title={priority} className={`inline-block w-2 h-2 rounded-full ${p.dot}`} />
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center h-5 px-1.5 text-[10px] font-medium text-zinc-500 bg-zinc-100 border border-zinc-200 rounded">
      {children}
    </kbd>
  )
}

function DaySeparator({ label }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-zinc-200" />
      <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-zinc-200" />
    </div>
  )
}


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   CONVERSATION LIST ITEM â Twenty CRM style
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function ConvItem({ conv, active, onClick }) {
  const name = contactDisplay(conv)
  const unread = conv.unread_count > 0
  const breached = conv.sla_state === 'breached'
  const lastInbound = conv.messages?.filter(m => m.direction === 'inbound').pop()
  const lastOutbound = conv.messages?.filter(m => m.direction === 'outbound').pop()
  const needsReply = lastInbound && (!lastOutbound || new Date(lastInbound.created_at) > new Date(lastOutbound.created_at))

  return (
    <button onClick={onClick}
      className={`group w-full text-left px-3.5 py-3 transition-all duration-150 border-b border-zinc-100/80 border-l-4 ${
        breached
          ? 'border-l-red-500 bg-red-50/30 hover:bg-red-50/50'
          : active
            ? 'border-l-blue-500 bg-blue-50/70 shadow-[inset_3px_0_0_0_#2563eb]'
            : unread
              ? 'border-l-zinc-100 bg-white hover:bg-zinc-50/80'
              : 'border-l-zinc-100 bg-white/60 hover:bg-zinc-50/60'
      }`}>
      <div className="flex items-start gap-3">
        <Avatar name={conv.client?.name || conv.external_contact} size="sm" />
        <div className="flex-1 min-w-0">
          {/* Row 1: Name + time */}
          <div className="flex items-center gap-1.5">
            <span className={`text-[13px] truncate flex-1 ${unread ? 'font-bold text-zinc-900' : 'font-medium text-zinc-600'}`}>
              {name}
            </span>
            <span className="text-[10px] text-zinc-400 shrink-0 tabular-nums font-medium">
              {relTime(conv.last_message_at)}
            </span>
          </div>

          {/* Row 2: Channel + assignee + priority + SLA */}
          <div className="flex items-center gap-1.5 mt-1">
            <ChannelBadge channel={conv.channel} compact />
            <PriorityDot priority={conv.priority} />
            {conv.assignee
              ? <span className="text-[10px] text-zinc-400 font-medium">{conv.assignee}</span>
              : <span className="text-[10px] text-amber-500 font-semibold">Unassigned</span>
            }
            <SlaBadge state={conv.sla_state} compact />
          </div>

          {/* Row 3: Preview with direction */}
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`text-zinc-400 shrink-0 ${conv.last_message_at && conv.messages?.length > 0 && conv.messages[conv.messages.length - 1]?.direction === 'inbound' ? 'text-zinc-400' : 'text-zinc-300'}`}>
              {conv.last_message_at && conv.messages?.length > 0 && conv.messages[conv.messages.length - 1]?.direction === 'inbound' ? (
                <ArrowLeft className="w-3.5 h-3.5" />
              ) : (
                <ArrowUpRight className="w-3.5 h-3.5" />
              )}
            </span>
            <p className={`text-[12px] leading-relaxed truncate flex-1 ${breached ? 'text-red-700 font-medium' : unread ? 'text-zinc-700' : 'text-zinc-400'}`}>
              {conv.preview || 'No messages yet'}
            </p>
            {needsReply && <div className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />}
          </div>
        </div>

        {/* Unread badge */}
        {unread && (
          <span className="mt-1 bg-blue-600 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 shadow-sm">
            {conv.unread_count > 9 ? '9+' : conv.unread_count}
          </span>
        )}
      </div>
    </button>
  )
}


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   MESSAGE BUBBLE â refined with delivery status + timestamps
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function MessageBubble({ m, isFirst, showTime, contactName }) {
  // Internal note
  if (m.is_internal_note) {
    return (
      <div className="flex justify-center my-3">
        <div className="max-w-[85%] bg-amber-50/80 border border-amber-200/60 text-amber-900 text-[13px] px-4 py-2.5 rounded-2xl backdrop-blur-sm">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-600 mb-1">
            <StickyNote className="w-3 h-3" />
            Internal note
            {m.author && <span className="font-normal text-amber-500">â {m.author}</span>}
            <span className="ml-auto font-normal text-amber-400">{fullTime(m.created_at)}</span>
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">{m.body}</div>
        </div>
      </div>
    )
  }

  const outbound = m.direction === 'outbound'

  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'} ${isFirst ? 'mt-3' : 'mt-1'}`}>
      <div className="max-w-[72%]">
        {/* Sender label on first message in group */}
        {isFirst && (
          <div className={`text-[10px] font-semibold mb-1 px-1 ${outbound ? 'text-right text-zinc-400' : 'text-zinc-500'}`}>
            {outbound ? (m.author || 'You') : (contactName || 'Customer')}
          </div>
        )}
        <div className={`px-4 py-2.5 text-[13px] leading-relaxed ${
          outbound
            ? 'bg-blue-600 text-white rounded-2xl rounded-br-lg shadow-sm'
            : 'bg-white text-zinc-800 rounded-2xl rounded-bl-lg shadow-sm border border-zinc-100'
        }`}>
          {m.subject && (
            <div className={`text-[11px] font-semibold mb-1 pb-1 border-b ${
              outbound ? 'border-blue-500/30 text-blue-100' : 'border-zinc-100 text-zinc-500'
            }`}>
              {m.channel === 'email' && <Mail className="w-3 h-3 inline mr-1 -mt-0.5" />}
              {m.subject}
            </div>
          )}
          <div className="whitespace-pre-wrap">{m.body}</div>
          <div className={`text-[11px] mt-1.5 flex items-center gap-1 font-medium ${outbound ? 'text-blue-100 justify-end' : 'text-zinc-600'}`}>
            {fullTime(m.created_at)}
            {outbound && m.status === 'delivered' && <CheckCircle2 className="w-3 h-3" />}
            {outbound && m.status === 'failed' && <AlertTriangle className="w-3 h-3 text-red-300" />}
            {m.channel === 'email' && <Mail className="w-3 h-3 ml-1 opacity-50" />}
          </div>
        </div>
      </div>
    </div>
  )
}


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   COMPOSE MODAL â New message (SMS or Email)
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function ComposeModal({ onClose, onSent, clients }) {
  const [channel, setChannel] = useState('sms')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [clientSuggestions, setClientSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  const handleToChange = (val) => {
    setTo(val)
    if (val.length > 1 && clients?.length) {
      const q = val.toLowerCase()
      const matches = clients.filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.phone?.includes(val) ||
        c.email?.toLowerCase().includes(q)
      ).slice(0, 5)
      setClientSuggestions(matches)
      setShowSuggestions(matches.length > 0)
    } else {
      setShowSuggestions(false)
    }
  }

  const selectClient = (c) => {
    setTo(channel === 'email' ? (c.email || '') : (c.phone || ''))
    setShowSuggestions(false)
  }

  const handleSend = async () => {
    if (!to.trim() || !body.trim()) return
    setSending(true); setError(null)
    try {
      if (channel === 'sms') {
        await post('/api/comms/sms', { to, body })
      } else {
        await post('/api/comms/email', { to, subject: subject || '(no subject)', body })
      }
      onSent?.()
      onClose()
    } catch (e) {
      setError(e.message || 'Failed to send')
    }
    setSending(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center">
              <PenLine className="w-4 h-4 text-blue-600" />
            </div>
            <span className="font-semibold text-zinc-900">New Message</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-zinc-100 flex items-center justify-center transition-colors">
            <X className="w-4 h-4 text-zinc-500" />
          </button>
        </div>

        {/* Channel toggle */}
        <div className="px-5 pt-4">
          <div className="flex gap-1 bg-zinc-100 rounded-xl p-1">
            {[
              { key: 'sms', label: 'SMS', icon: Phone },
              { key: 'email', label: 'Email', icon: Mail },
            ].map(ch => {
              const Icon = ch.icon
              return (
                <button key={ch.key} onClick={() => setChannel(ch.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg transition-all ${
                    channel === ch.key
                      ? 'bg-white text-zinc-900 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-700'
                  }`}>
                  <Icon className="w-3.5 h-3.5" />
                  {ch.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-3">
          <div className="relative">
            <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">
              To
            </label>
            <input value={to} onChange={e => handleToChange(e.target.value)}
              onFocus={() => clientSuggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              placeholder={channel === 'email' ? 'email@example.com' : '+1 (207) 555-1234'}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-[13px] placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all" />
            {showSuggestions && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden">
                {clientSuggestions.map(c => (
                  <button key={c.id} onClick={() => selectClient(c)}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-zinc-50 flex items-center gap-2.5 transition-colors">
                    <Avatar name={c.name} size="xs" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-zinc-900 truncate">{c.name}</div>
                      <div className="text-[11px] text-zinc-400 truncate">
                        {channel === 'email' ? c.email : formatPhone(c.phone)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {channel === 'email' && (
            <div>
              <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">Subject</label>
              <input value={subject} onChange={e => setSubject(e.target.value)}
                placeholder="Subject line"
                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-[13px] placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all" />
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">Message</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
              placeholder={channel === 'email' ? 'Write your email...' : 'Type your SMS message...'}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-[13px] placeholder-zinc-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all leading-relaxed"
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSend() }} />
            {channel === 'sms' && (
              <div className="text-[10px] text-zinc-400 mt-1 text-right">{body.length}/160 chars</div>
            )}
          </div>

          {error && (
            <div className="text-[12px] text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-100 flex items-center justify-between">
          <div className="text-[10px] text-zinc-400 flex items-center gap-1">
            <Kbd>{navigator.platform?.includes('Mac') ? 'â' : 'Ctrl'}</Kbd>
            <span>+</span>
            <Kbd>Enter</Kbd>
            <span className="ml-1">to send</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="text-[13px] font-medium px-4 py-2 rounded-xl text-zinc-600 hover:bg-zinc-100 transition-all">
              Cancel
            </button>
            <button onClick={handleSend} disabled={sending || !to.trim() || !body.trim()}
              className="text-[13px] font-semibold px-5 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 shadow-sm transition-all flex items-center gap-1.5">
              {sending
                ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <><Send className="w-3.5 h-3.5" /> Send</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   CONTACT PANEL â Twenty CRM record-detail + Fieldcamp unified profile
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

function ContactPanel({ detail, onAssign, onPriority, onStatus, onClose }) {
  if (!detail) return null
  const name = contactDisplay(detail)
  const client = detail.client

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
    <div className="w-[320px] border-l border-zinc-200 bg-white flex flex-col overflow-hidden">
      {/* Contact header */}
      <div className="p-5 bg-gradient-to-b from-zinc-50 to-white border-b border-zinc-100">
        <div className="flex items-start gap-3">
          <Avatar name={client?.name || detail.external_contact} size="lg" />
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-zinc-900 text-[15px] truncate leading-tight">{name}</h3>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                client?.status === 'active'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-zinc-100 text-zinc-500'
              }`}>
                {(client?.status || 'new').toUpperCase()}
              </span>
              <ChannelBadge channel={detail.channel} />
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-zinc-100 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-colors lg:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Contact info chips */}
        <div className="mt-3 space-y-1.5">
          {(client?.phone || detail.external_contact) && (
            <a href={`tel:${client?.phone || detail.external_contact}`}
              className="flex items-center gap-2 text-[12px] text-zinc-600 hover:text-blue-600 transition-colors group">
              <div className="w-6 h-6 rounded-lg bg-zinc-100 group-hover:bg-blue-50 flex items-center justify-center transition-colors">
                <Phone className="w-3 h-3 text-zinc-400 group-hover:text-blue-500" />
              </div>
              {formatPhone(client?.phone || detail.external_contact)}
            </a>
          )}
          {client?.email && (
            <a href={`mailto:${client.email}`}
              className="flex items-center gap-2 text-[12px] text-zinc-600 hover:text-blue-600 transition-colors group">
              <div className="w-6 h-6 rounded-lg bg-zinc-100 group-hover:bg-blue-50 flex items-center justify-center transition-colors">
                <Mail className="w-3 h-3 text-zinc-400 group-hover:text-blue-500" />
              </div>
              {client.email}
            </a>
          )}
          {client?.address && (
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <div className="w-6 h-6 rounded-lg bg-zinc-100 flex items-center justify-center">
                <MapPin className="w-3 h-3 text-zinc-400" />
              </div>
              {client.address}
            </div>
          )}
        </div>

        {client && (
          <a href={`/clients/${client.id}`}
            className="mt-3 w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2 rounded-xl transition-all">
            <User className="w-3.5 h-3.5" /> View Full Profile
          </a>
        )}
      </div>

      {/* Controls */}
      <div className="overflow-y-auto flex-1">
        <div className="p-4 space-y-4 border-b border-zinc-100">
          {/* Assignee */}
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">Assignee</label>
            <select value={detail.assignee || 'Unassigned'} onChange={e => onAssign(e.target.value)}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-[13px] text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all appearance-none cursor-pointer">
              {TEAM_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {/* Priority */}
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">Priority</label>
            <div className="grid grid-cols-4 gap-1.5">
              {['low', 'normal', 'high', 'urgent'].map(p => {
                const active = detail.priority === p
                const pc = PRIORITY_COLORS[p]
                return (
                  <button key={p} onClick={() => onPriority(p)}
                    className={`text-[11px] font-medium py-1.5 rounded-lg capitalize transition-all ${
                      active
                        ? `${pc.active} ring-1`
                        : 'bg-zinc-50 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'
                    }`}>
                    {p}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Status actions */}
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">Status</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => onStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
                className={`text-[11px] font-medium py-2 rounded-lg flex items-center justify-center gap-1 transition-all ${
                  detail.status === 'resolved'
                    ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200'
                    : 'bg-zinc-50 text-zinc-500 hover:bg-emerald-50 hover:text-emerald-700'
                }`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                {detail.status === 'resolved' ? 'Resolved' : 'Resolve'}
              </button>
              <button onClick={() => onStatus('snoozed')} disabled={detail.status === 'snoozed'}
                className={`text-[11px] font-medium py-2 rounded-lg flex items-center justify-center gap-1 transition-all ${
                  detail.status === 'snoozed'
                    ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200'
                    : 'bg-zinc-50 text-zinc-500 hover:bg-amber-50 hover:text-amber-700'
                } disabled:opacity-40`}>
                <Clock className="w-3.5 h-3.5" />
                Snooze
              </button>
            </div>
          </div>

          {/* SLA */}
          {detail.sla_deadline && (
            <div className="bg-zinc-50 rounded-xl p-3">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-2">SLA</label>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-zinc-500">Response target</span>
                <span className="font-semibold text-zinc-700">{detail.sla_response_minutes}m</span>
              </div>
              <div className="flex items-center justify-between text-[12px] mt-1">
                <span className="text-zinc-500">Deadline</span>
                <span className="font-semibold text-zinc-700">
                  {new Date(detail.sla_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="mt-2"><SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} /></div>
            </div>
          )}

          {/* Tags */}
          {detail.tags?.length > 0 && (
            <div>
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">Tags</label>
              <div className="flex flex-wrap gap-1">
                {detail.tags.map(t => (
                  <span key={t} className="inline-flex items-center gap-1 text-[11px] bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full font-medium">
                    <Hash className="w-2.5 h-2.5" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Activity Timeline â Fieldcamp-inspired */}
        <div className="p-4">
          <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-3">
            Activity Timeline
          </label>
          {timeline.length === 0 ? (
            <div className="text-[12px] text-zinc-400 text-center py-4">No activity yet</div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[11px] top-2 bottom-2 w-px bg-zinc-200" />
              <div className="space-y-3">
                {timeline.map(item => {
                  const iconConfig = {
                    note:     { icon: StickyNote, bg: 'bg-amber-100', text: 'text-amber-600' },
                    inbound:  { icon: ArrowLeft,  bg: 'bg-zinc-100',  text: 'text-zinc-500' },
                    outbound: { icon: Send,       bg: 'bg-blue-100',  text: 'text-blue-600' },
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
                          <span className="text-[11px] font-semibold text-zinc-700">{item.author}</span>
                          {item.channel && <ChannelBadge channel={item.channel} compact />}
                          <span className="text-[10px] text-zinc-400 ml-auto shrink-0">{relTime(item.time)}</span>
                        </div>
                        <p className="text-[11px] text-zinc-500 mt-0.5 truncate leading-relaxed">{item.body}</p>
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


/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   MAIN COMMS PAGE
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

export default function Comms() {
  // State
  const [convs, setConvs] = useState([])
  const [summary, setSummary] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [clients, setClients] = useState([])

  const [filter, setFilter] = useState('open')
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

  const threadRef = useRef(null)
  const replyRef = useRef(null)

  // ââââââââ Data fetching ââââââââ

  const loadList = useCallback(async () => {
    const params = new URLSearchParams()
    if (filter === 'mine')        params.set('assignee', 'Megan')
    else if (filter === 'unassigned') params.set('assignee', 'unassigned')
    else if (filter === 'unread') params.set('unread_only', 'true')
    else if (filter === 'breached') params.set('sla_state', 'breached')
    else if (filter === 'resolved') params.set('status', 'resolved')
    else if (filter === 'open')   params.set('status', 'open')
    if (channelFilter) params.set('channel', channelFilter)
    if (search) params.set('q', search)
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

  const loadClients = useCallback(async () => {
    try { setClients(await get('/api/clients?limit=100')) }
    catch (e) { console.error('[Comms] loadClients:', e) }
  }, [])

  // ââââââââ Effects ââââââââ

  useEffect(() => { loadList(); loadSummary(); loadClients() }, [loadList, loadSummary, loadClients])
  useEffect(() => { const t = setTimeout(() => loadList(), 300); return () => clearTimeout(t) }, [search])
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

  // ââââââââ Actions ââââââââ

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

  // ââââââââ Filter config ââââââââ

  const filterItems = useMemo(() => ([
    { key: 'open',       label: 'Open',       icon: Inbox,        count: summary.open },
    { key: 'breached',   label: 'Breached',   icon: AlertTriangle, count: summary.breached },
    { key: 'mine',       label: 'Mine',       icon: User,         count: null },
    { key: 'unassigned', label: 'Unassigned', icon: UserPlus,     count: summary.unassigned },
    { key: 'unread',     label: 'Unread',     icon: Bell,         count: summary.unread },
    { key: 'resolved',   label: 'Resolved',   icon: CheckCircle2, count: summary.resolved },
  ]), [summary])

  // ââââââââ Message grouping with day separators ââââââââ

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


  /* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
     RENDER
     âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

  
  // Gmail inbox mode: when Email tab is selected, render GmailInbox instead
  if (channelFilter === 'email') {
    return (
      <div className="flex h-full bg-zinc-50">
        <div className="flex flex-col flex-1 h-full">
          {/* Mini top bar with channel tabs */}
          <div className="bg-white border-b border-zinc-200 px-4 py-3 flex items-center gap-4 shrink-0">
            <h1 className="text-lg font-bold text-zinc-900 tracking-tight">Comms</h1>
            <div className="flex gap-1 bg-zinc-100 rounded-xl p-1">
              {[
                { key: '', label: 'All' },
                { key: 'sms', label: 'SMS', icon: Phone },
                { key: 'email', label: 'Email', icon: Mail },
              ].map(ch => {
                const Icon = ch.icon
                return (
                  <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
                    className={`flex items-center gap-1 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
                      channelFilter === ch.key
                        ? 'bg-white text-zinc-900 shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-700'
                    }`}>
                    {Icon && <Icon className="w-3.5 h-3.5" />}
                    {ch.label}
                  </button>
                )
              })}
            </div>
          </div>
          <GmailInbox />
        </div>
        <AgentWidget pageContext="comms" prompts={[
          'Summarize recent emails from clients',
          'Draft a reply to this email',
          'Create a lead from this email sender',
        ]} />
      </div>
    )
  }

  return (
    <div className="flex h-full bg-zinc-50">

      {/* âââ LEFT PANEL: Filters + Conversation List âââ */}
      <div className={`w-[340px] border-r border-zinc-200 bg-white flex flex-col shrink-0
        ${mobileView === 'thread' ? 'hidden lg:flex' : 'flex'}`}>

        {/* Header */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-zinc-900 tracking-tight">Inbox</h1>
            <button onClick={() => setShowCompose(true)}
              className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-sm transition-all hover:shadow-md active:scale-95">
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full bg-zinc-50 border border-zinc-200 rounded-xl pl-9 pr-3 py-2.5 text-[13px] placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 focus:bg-white transition-all" />
          </div>
        </div>

        {/* Channel tabs */}
        <div className="px-4 pb-3">
          <div className="flex gap-1 bg-zinc-100 rounded-xl p-1">
            {[
              { key: '', label: 'All', count: (summary.open || 0) + (summary.resolved || 0) },
              { key: 'sms', label: 'SMS', icon: Phone },
              { key: 'email', label: 'Email', icon: Mail },
            ].map(ch => {
              const Icon = ch.icon
              return (
                <button key={ch.key} onClick={() => setChannelFilter(ch.key)}
                  className={`flex-1 flex items-center justify-center gap-1 text-[12px] font-semibold px-2 py-2 rounded-lg transition-all ${
                    channelFilter === ch.key
                      ? 'bg-white text-zinc-900 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-700'
                  }`}>
                  {Icon && <Icon className="w-3.5 h-3.5" />}
                  {ch.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Status filters â Twenty CRM sidebar style */}
        <div className="border-y border-zinc-100">
          {filterItems.map(({ key, label, icon: Ic, count }) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] transition-all ${
                filter === key
                  ? 'bg-blue-50/70 text-blue-700 font-semibold shadow-[inset_3px_0_0_0_#2563eb]'
                  : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700'
              }`}>
              <Ic className={`w-4 h-4 ${filter === key ? 'text-blue-600' : 'text-zinc-400'}`} />
              <span className="flex-1 text-left">{label}</span>
              {count != null && count > 0 && (
                <span className={`text-[11px] font-bold tabular-nums px-2 py-0.5 rounded-full min-w-[22px] text-center ${
                  filter === key ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
                }`}>{count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {convs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <div className="w-14 h-14 rounded-2xl bg-zinc-100 flex items-center justify-center mb-4">
                <Inbox className="w-7 h-7 text-zinc-300" />
              </div>
              <div className="text-sm font-semibold text-zinc-500 mb-1">No conversations</div>
              <p className="text-[12px] text-zinc-400 text-center leading-relaxed">
                Messages will appear here when they come in, or start a new one.
              </p>
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


      {/* âââ CENTER PANEL: Thread View âââ */}
      <div className={`flex-1 flex flex-col min-w-0 ${mobileView === 'list' ? 'hidden lg:flex' : 'flex'}`}>
        {!detail ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center bg-zinc-50/50">
            <div className="text-center max-w-xs">
              <div className="w-20 h-20 rounded-3xl bg-white border border-zinc-200 flex items-center justify-center mx-auto mb-5 shadow-sm">
                <MessageSquare className="w-10 h-10 text-zinc-300" />
              </div>
              <h2 className="text-base font-bold text-zinc-700 mb-2">Select a conversation</h2>
              <p className="text-[13px] text-zinc-400 leading-relaxed mb-4">
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
            {/* SLA breach banner */}
            {detail.sla_state === 'breached' && (
              <div className="bg-red-50 border-b border-red-200 px-5 py-2.5 flex items-center gap-2 text-[12px] font-medium text-red-700">
                <AlertTriangle className="w-4 h-4" />
                SLA breached — last message {relTime(detail.last_inbound_at)} ago
              </div>
            )}

            {/* Thread header */}
            <div className="border-b border-zinc-200 px-5 py-3.5 flex items-center gap-3 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              {/* Mobile back button */}
              <button onClick={() => setMobileView('list')}
                className="w-8 h-8 rounded-lg hover:bg-zinc-100 flex items-center justify-center text-zinc-500 lg:hidden">
                <ArrowLeft className="w-4 h-4" />
              </button>

              <Avatar name={detail.client?.name || detail.external_contact} size="md" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-zinc-900 text-[15px] truncate">{contactDisplay(detail)}</h2>
                  <ChannelBadge channel={detail.channel} />
                  <SlaBadge state={detail.sla_state} deadline={detail.sla_deadline} />
                </div>
                <div className="text-[12px] text-zinc-500 mt-0.5 truncate flex items-center gap-2">
                  {detail.client?.phone && (
                    <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{formatPhone(detail.client.phone)}</span>
                  )}
                  {detail.client?.email && (
                    <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{detail.client.email}</span>
                  )}
                  {!detail.client?.phone && !detail.client?.email && detail.external_contact && (
                    <span>{formatPhone(detail.external_contact)}</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5">
                <button onClick={() => setStatus(detail.status === 'resolved' ? 'open' : 'resolved')}
                  className={`text-[12px] font-semibold px-3.5 py-2 rounded-xl transition-all flex items-center gap-1.5 ${
                    detail.status === 'resolved'
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 ring-1 ring-emerald-200'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-emerald-50 hover:text-emerald-700'
                  }`}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {detail.status === 'resolved' ? 'Resolved' : 'Resolve'}
                </button>
                <button onClick={() => setShowContactPanel(!showContactPanel)}
                  className="w-8 h-8 rounded-lg bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center text-zinc-500 transition-colors hidden lg:flex">
                  <User className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages thread */}
            <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 bg-zinc-50/50">
              {loadingDetail && (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-zinc-300 border-t-blue-600 rounded-full animate-spin" />
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
                  <div className="w-12 h-12 rounded-2xl bg-white border border-zinc-200 flex items-center justify-center mb-3 shadow-sm">
                    <MessageCircle className="w-6 h-6 text-zinc-300" />
                  </div>
                  <p className="text-[13px] text-zinc-400">No messages yet. Start the conversation below.</p>
                </div>
              )}
            </div>

            {/* Compose bar */}
            <div className="border-t border-zinc-200 bg-white p-4">
              {/* Mode toggle */}
              <div className="flex items-center gap-1.5 mb-3">
                <button onClick={() => setNoteMode(false)}
                  className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
                    !noteMode ? 'bg-blue-600 text-white shadow-sm' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                  }`}>
                  <Send className="w-3 h-3" /> Reply
                </button>
                <button onClick={() => setNoteMode(true)}
                  className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-all ${
                    noteMode ? 'bg-amber-500 text-white shadow-sm' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                  }`}>
                  <StickyNote className="w-3 h-3" /> Note
                </button>

                <div className="flex-1" />

                {flash && (
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg animate-fade-in ${
                    flash.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                  }`}>{flash.msg}</span>
                )}
              </div>

              {/* Email subject line */}
              {detail.channel === 'email' && !noteMode && (
                <input value={replySubject} onChange={e => setReplySubject(e.target.value)}
                  placeholder={detail.subject ? `Re: ${detail.subject}` : 'Subject'}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2 text-[13px] mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all" />
              )}

              {/* Reply input */}
              <div className="flex gap-2">
                <textarea ref={replyRef} value={reply} onChange={e => setReply(e.target.value)} rows={2}
                  placeholder={noteMode
                    ? 'Write an internal note (not sent to customer)...'
                    : `Reply via ${(detail.channel || 'sms').toUpperCase()}...`
                  }
                  className={`flex-1 border rounded-xl px-4 py-3 text-[13px] resize-none focus:outline-none focus:ring-2 transition-all leading-relaxed ${
                    noteMode
                      ? 'border-amber-200 bg-amber-50/50 focus:ring-amber-500/20 placeholder-amber-400'
                      : 'border-zinc-200 bg-zinc-50 focus:ring-blue-500/20 focus:bg-white placeholder-zinc-400'
                  }`}
                  onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply() }} />
                <button onClick={sendReply} disabled={sending || !reply.trim()}
                  className={`px-5 rounded-xl text-[13px] font-semibold self-stretch disabled:opacity-40 transition-all active:scale-95 shadow-sm ${
                    noteMode
                      ? 'bg-amber-500 hover:bg-amber-600 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}>
                  {sending
                    ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : noteMode ? 'Save' : 'Send'
                  }
                </button>
              </div>

              <div className="flex items-center mt-2">
                <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                  <Kbd>{navigator.platform?.includes('Mac') ? 'â' : 'Ctrl'}</Kbd>
                  <span>+</span>
                  <Kbd>Enter</Kbd>
                  <span className="ml-1">to send</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>


      {/* âââ RIGHT PANEL: Contact Detail âââ */}
      {detail && showContactPanel && (
        <ContactPanel
          detail={detail}
          onAssign={setAssignee}
          onPriority={setPriority}
          onStatus={setStatus}
          onClose={() => setShowContactPanel(false)}
        />
      )}


      {/* âââ Compose Modal âââ */}
      {showCompose && (
        <ComposeModal
          clients={clients}
          onClose={() => setShowCompose(false)}
          onSent={() => { loadList(); loadSummary() }}
        />
      )}


      {/* âââ Agent Widget âââ */}
      <AgentWidget pageContext="comms" prompts={[
        'Draft a follow-up SMS for my recent leads',
        'Summarize the selected conversation',
        'Help me write a thank-you message after a job',
      ]} />
    </div>
  )
}
