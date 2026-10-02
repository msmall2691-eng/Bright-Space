import { useState, useRef } from 'react'
import { PenLine, Phone, Mail, AlertTriangle, Send } from 'lucide-react'
import { post } from '../../api'
import { formatPhone } from '../../utils/display'
import { Avatar, Kbd } from './primitives'
import Modal from '../ui/Modal'

/** New-message modal — pick SMS or Email, type-ahead client suggestions,
 *  Cmd/Ctrl+Enter to send. Calls onSent(response) then onClose().
 *
 *  Optional prefill (used when opened from a specific customer, e.g. the
 *  schedule's visit drawer): `initialTo`/`initialChannel` seed the recipient
 *  and channel, and `clientId` links the outbound message to that client's
 *  conversation thread even if `to` is later edited. Omit them for the generic
 *  Comms "New Message" entry point — behavior is unchanged.
 *
 *  Built on the shared ui/Modal shell (focus-trap / Esc / scroll-lock / aria);
 *  the parent only mounts it while composing, so `open` is always true here.
 *  Dismiss is gated while a send is in flight. */
export function ComposeModal({ onClose, onSent, clients, initialTo = '', initialChannel = 'sms', clientId = null }) {
  const [channel, setChannel] = useState(initialChannel || 'sms')
  const [to, setTo] = useState(initialTo || '')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [clientSuggestions, setClientSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const toRef = useRef(null)

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
      // Pass client_id when we opened for a known customer so the outbound
      // message attaches to their existing conversation thread (the backend
      // otherwise best-effort matches by phone/email).
      const link = clientId ? { client_id: clientId } : {}
      let response
      if (channel === 'sms') {
        response = await post('/api/comms/sms', { to, body, ...link })
      } else {
        response = await post('/api/comms/email', { to, subject: subject || '(no subject)', body, ...link })
      }
      onSent?.(response)
      onClose()
    } catch (e) {
      setError(e.message || 'Failed to send')
    }
    setSending(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!sending}
      maxWidth="lg"
      initialFocusRef={toRef}
      ariaLabel="New message"
      title={
        <div className="flex items-center gap-2.5 min-w-0">
          <PenLine className="w-5 h-5 text-ink-3 shrink-0" />
          <span className="text-sm font-semibold text-ink">New Message</span>
        </div>
      }
    >
      {/* Channel toggle — stays put above the scrolling form. */}
      <div className="px-5 pt-4 shrink-0">
        <div className="flex gap-1 bg-bg-2 rounded-xl p-1">
          {[
            { key: 'sms', label: 'SMS', icon: Phone },
            { key: 'email', label: 'Email', icon: Mail },
          ].map(ch => {
            const Icon = ch.icon
            return (
              <button key={ch.key} onClick={() => setChannel(ch.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg transition-all ${
                  channel === ch.key
                    ? 'bg-panel text-ink shadow-xs'
                    : 'text-ink-3 hover:text-ink-2'
                }`}>
                <Icon className="w-3.5 h-3.5" />
                {ch.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Form — its own scroll region so the footer's Send button stays
          reachable on phones when the keyboard is up. */}
      <Modal.Body className="space-y-3">
        <div className="relative">
          <label className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider block mb-1">
            To
          </label>
          <input ref={toRef} value={to} onChange={e => handleToChange(e.target.value)}
            onFocus={() => clientSuggestions.length > 0 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder={channel === 'email' ? 'email@example.com' : '+1 (207) 555-1234'}
            className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2.5 text-base sm:text-[13px] placeholder-ink-3 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all" />
          {showSuggestions && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-panel border border-hairline rounded-xl shadow-lg overflow-hidden">
              {clientSuggestions.map(c => (
                <button key={c.id} onClick={() => selectClient(c)}
                  className="w-full text-left px-3.5 py-2.5 hover:bg-bg flex items-center gap-2.5 transition-colors">
                  <Avatar name={c.name} size="xs" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                    <div className="text-[11px] text-ink-3 truncate">
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
            <label className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider block mb-1">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="Subject line"
              className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2.5 text-base sm:text-[13px] placeholder-ink-3 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all" />
          </div>
        )}

        <div>
          <label className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider block mb-1">Message</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
            placeholder={channel === 'email' ? 'Write your email...' : 'Type your SMS message...'}
            className="w-full bg-bg border border-hairline rounded-xl px-3.5 py-2.5 text-base sm:text-[13px] placeholder-ink-3 resize-none focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all leading-relaxed"
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSend() }} />
          {channel === 'sms' && (
            <div className="text-[10px] text-ink-3 mt-1 text-right">{body.length}/160 chars</div>
          )}
        </div>

        {error && (
          <div className="text-[12px] text-red-600 dark:text-red-300 bg-panel border border-hairline rounded-xl px-3 py-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}
      </Modal.Body>

      {/* Footer — keyboard hint left, actions right (own layout, not the
          shell's right-aligned default). */}
      <footer className="px-5 py-4 border-t border-hairline flex items-center justify-between shrink-0">
        <div className="text-[10px] text-ink-3 flex items-center gap-1">
          <Kbd>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}</Kbd>
          <span>+</span>
          <Kbd>Enter</Kbd>
          <span className="ml-1">to send</span>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose}
            className="text-[13px] font-medium px-4 py-2 rounded-xl text-ink-2 hover:bg-bg-2 transition-all">
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending || !to.trim() || !body.trim()}
            className="text-[13px] font-semibold px-5 py-2 min-h-[44px] sm:min-h-0 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 shadow-xs transition-all flex items-center gap-1.5">
            {sending
              ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <><Send className="w-3.5 h-3.5" /> Send</>
            }
          </button>
        </div>
      </footer>
    </Modal>
  )
}
