import { useState, useEffect, useRef } from 'react'
import { Mail, User, UserPlus, Paperclip, ArrowLeft, RefreshCw, Link2, ExternalLink, Clock, Inbox, Search, Send, X, AlertCircle } from 'lucide-react'
import { get, post } from '../api'

function timeAgo(dateStr) {
  const d = new Date(dateStr)
  const now = new Date()
  const mins = Math.floor((now - d) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDate(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function ReplyPanel({ email, onSent, onCancel, fromEmail }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const bodyRef = useRef(null)

  useEffect(() => {
    if (bodyRef.current) {
      setTimeout(() => bodyRef.current?.focus(), 50)
    }
  }, [])

  const handleSend = async () => {
    if (!body.trim()) {
      setError('Reply message cannot be empty')
      return
    }

    if (!fromEmail) {
      setError('from_email not configured')
      return
    }

    setSending(true)
    setError(null)

    try {
      const res = await post(
        `/api/gmail/send-reply?to_email=${encodeURIComponent(email.from_email)}&subject=${encodeURIComponent('Re: ' + email.subject)}&body=${encodeURIComponent(body)}&in_reply_to_message_id=${encodeURIComponent(email.message_id)}`
      )

      if (res.status === 'sent') {
        setBody('')
        onSent(res.message)
      } else {
        setError(res.message || 'Failed to send reply')
      }
    } catch (err) {
      setError(err.message || 'Failed to send reply')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-gray-200 bg-gray-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Compose Reply</h3>
        <button
          onClick={onCancel}
          className="p-1 rounded-md hover:bg-gray-200 text-gray-500"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-xs text-red-700">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">From</label>
          <div className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900">
            {fromEmail || 'Not configured'}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">To</label>
          <div className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900">
            {email.from_email}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Subject</label>
          <div className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900">
            Re: {email.subject}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Message</label>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Type your reply here..."
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            rows="5"
          />
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={sending}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !body.trim()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            <Send className="w-3 h-3" />
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function GmailInbox() {
  const [emails, setEmails] = useState([])
  const [summary, setSummary] = useState({ total: 0, linked: 0, unlinked: 0, unread: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [creating, setCreating] = useState(null)
  const [showReplyPanel, setShowReplyPanel] = useState(false)
  const [connectionError, setConnectionError] = useState(null)
  const [fromEmail, setFromEmail] = useState(null)
  const detailRef = useRef(null)

  const loadFromEmail = async () => {
    try {
      const res = await get('/api/settings/from-email')
      setFromEmail(res.from_email)
    } catch (err) {
      console.error('Failed to load from_email:', err)
    }
  }

  const load = () => {
    setLoading(true)
    setError(null)
    setConnectionError(null)
    get('/api/gmail/inbox?max_results=40&skip_automated=true')
      .then(data => {
        if (data.error) {
          setConnectionError(data)
          setEmails([])
        } else {
          setEmails(data.emails || [])
        }
        setSummary(data.summary || {})
        setLoading(false)
      })
      .catch(err => {
        console.error('Gmail fetch error:', err)
        setError('Could not load Gmail inbox.')
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
    loadFromEmail()
  }, [])

  useEffect(() => {
    if (selected && detailRef.current) {
      detailRef.current.scrollTop = 0
    }
  }, [selected])

  const createLead = async (em) => {
    setCreating(em.id)
    try {
      const res = await post(`/api/gmail/create-lead?from_name=${encodeURIComponent(em.from_name)}&from_email=${encodeURIComponent(em.from_email)}`)
      if (res.client) {
        setEmails(prev => prev.map(e =>
          e.from_email === em.from_email
            ? { ...e, client: res.client, is_known_contact: true }
            : e
        ))
        if (selected && selected.from_email === em.from_email) {
          setSelected(s => ({ ...s, client: res.client, is_known_contact: true }))
        }
      }
    } catch (err) {
      console.error('Create lead error:', err)
    }
    setCreating(null)
  }

  const handleReplySent = (message) => {
    setShowReplyPanel(false)
    const newEmail = {
      id: `sent-${Date.now()}`,
      from_name: 'You',
      from_email: message.from || 'support@example.com',
      to: message.to,
      subject: message.subject,
      snippet: message.body.substring(0, 280),
      body: message.body,
      date: new Date().toISOString(),
      is_read: true,
      has_attachments: false,
      direction: 'outbound',
      is_known_contact: true,
    }
    setEmails(prev => [newEmail, ...prev])
    setTimeout(() => load(), 500)
  }

  const filtered = emails.filter(em => {
    if (filter === 'linked' && !em.is_known_contact) return false
    if (filter === 'leads' && em.is_known_contact) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        em.from_name.toLowerCase().includes(q) ||
        em.from_email.toLowerCase().includes(q) ||
        em.subject.toLowerCase().includes(q) ||
        (em.snippet || '').toLowerCase().includes(q)
      )
    }
    return true
  })

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <Mail className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-sm">{error}</p>
          <button onClick={load} className="mt-3 text-sm text-blue-600 hover:underline">Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 h-full overflow-hidden bg-white">
      {/* Left pane: Email list */}
      <div className={`lg:w-[420px] border-r border-gray-200 flex flex-col bg-white transition-all duration-300 ${
        selected ? 'hidden lg:flex' : 'flex'
      }`}>
        {/* Header */}
        <div className="px-4 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <Mail className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">Messages</h2>
                <p className="text-xs text-gray-500">{summary.total} emails</p>
              </div>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-50 transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search emails..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
            />
          </div>

          {/* Filter pills */}
          <div className="flex gap-2 flex-wrap">
            {[
              { key: 'all', label: 'All', count: summary.total },
              { key: 'linked', label: 'Clients', count: summary.linked },
              { key: 'leads', label: 'Leads', count: summary.unlinked },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all ${
                  filter === f.key
                    ? 'bg-blue-100 text-blue-700 shadow-sm'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {f.label} {f.count > 0 && <span className="ml-1 opacity-70">({f.count})</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Email list */}
        <div className="flex-1 overflow-y-auto">
          {loading && emails.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading emails...
            </div>
          ) : connectionError ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mb-3">
                <Mail className="w-6 h-6 text-amber-500" />
              </div>
              <div className="text-sm font-medium text-zinc-700 mb-1">
                {connectionError.error === 'no_credentials' ? 'Email Not Connected' :
                 connectionError.error === 'auth_failed' ? 'Authentication Failed' : 'Connection Error'}
              </div>
              <p className="text-xs text-zinc-500 max-w-xs mb-3">{connectionError.message}</p>
              <a href="/settings" className="text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg transition-colors">
                Go to Settings
              </a>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              <Inbox className="w-5 h-5 mr-2" /> No emails found
            </div>
          ) : (
            filtered.map(em => (
              <div
                key={em.id}
                onClick={() => {
                  setSelected(em)
                  setShowReplyPanel(false)
                }}
                className={`px-4 py-3 border-b border-gray-100 cursor-pointer transition-colors ${
                  selected?.id === em.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                } ${!em.is_read ? 'bg-blue-50/40' : ''}`}
              >
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5 ${
                    em.direction === 'outbound'
                      ? 'bg-blue-100 text-blue-700'
                      : em.is_known_contact
                      ? 'bg-green-100 text-green-700'
                      : 'bg-orange-100 text-orange-700'
                  }`}>
                    {em.direction === 'outbound'
                      ? 'Y'
                      : em.is_known_contact
                      ? em.client?.name?.charAt(0)?.toUpperCase() || 'C'
                      : em.from_name?.charAt(0)?.toUpperCase() || '?'
                    }
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-sm truncate ${!em.is_read ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                        {em.direction === 'outbound' ? 'You' : (em.is_known_contact ? em.client?.name : em.from_name)}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0 ml-2">{timeAgo(em.date)}</span>
                    </div>

                    <p className={`text-sm truncate mb-1.5 ${!em.is_read ? 'text-gray-900 font-medium' : 'text-gray-600'}`}>
                      {em.subject}
                    </p>

                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-400 truncate flex-1">{em.snippet}</p>
                      <div className="flex items-center gap-1 shrink-0">
                        {em.has_attachments && <Paperclip className="w-3 h-3 text-gray-400" />}
                        {em.direction === 'outbound' ? (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-600 rounded">Sent</span>
                        ) : em.is_known_contact ? (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-50 text-green-600 rounded">Client</span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-50 text-orange-600 rounded">Lead</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right pane: Email detail */}
      <div className={`flex-1 flex flex-col bg-white overflow-hidden transition-all duration-300 ${
        selected ? 'flex' : 'hidden lg:flex'
      }`}>
        {selected ? (
          <>
            {/* Detail header */}
            <div className="px-4 lg:px-6 py-4 border-b border-gray-200 shrink-0">
              <button
                onClick={() => {
                  setSelected(null)
                  setShowReplyPanel(false)
                }}
                className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 lg:hidden mb-3"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>

              <h2 className="text-lg font-semibold text-gray-900 mb-3">{selected.subject}</h2>

              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                    selected.direction === 'outbound'
                      ? 'bg-blue-100 text-blue-700'
                      : selected.is_known_contact
                      ? 'bg-green-100 text-green-700'
                      : 'bg-orange-100 text-orange-700'
                  }`}>
                    {selected.direction === 'outbound'
                      ? 'Y'
                      : selected.is_known_contact
                      ? selected.client?.name?.charAt(0)?.toUpperCase() || 'C'
                      : selected.from_name?.charAt(0)?.toUpperCase() || '?'
                    }
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-gray-900 truncate">
                        {selected.direction === 'outbound' ? 'You' : selected.from_name}
                      </span>
                      {selected.direction !== 'outbound' && selected.is_known_contact ? (
                        <a
                          href={`/clients?id=${selected.client.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 rounded-full hover:bg-green-100 transition-colors"
                        >
                          <Link2 className="w-3 h-3" />
                          {selected.client.name}
                        </a>
                      ) : (
                        selected.direction !== 'outbound' && (
                          <button
                            onClick={() => createLead(selected)}
                            disabled={creating === selected.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-orange-50 text-orange-700 rounded-full hover:bg-orange-100 disabled:opacity-50 transition-colors"
                          >
                            <UserPlus className="w-3 h-3" />
                            {creating === selected.id ? 'Creating...' : 'Create Lead'}
                          </button>
                        )
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{selected.from_email}</p>
                  </div>
                </div>

                {selected.direction !== 'outbound' && (
                  <button
                    onClick={() => setShowReplyPanel(!showReplyPanel)}
                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
                  >
                    Reply
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 text-xs text-gray-500 mt-3">
                <Clock className="w-3.5 h-3.5" />
                {formatDate(selected.date)}
              </div>

              {selected.to && (
                <p className="text-xs text-gray-400 mt-2">
                  To: {selected.to}
                </p>
              )}
            </div>

            {/* Email body */}
            <div ref={detailRef} className="flex-1 overflow-y-auto px-4 lg:px-6 py-5">
              <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap leading-relaxed font-normal">
                {selected.body || selected.snippet || '(No content)'}
              </div>
            </div>

            {/* Reply panel */}
            {showReplyPanel && selected.direction !== 'outbound' && (
              <ReplyPanel
                email={selected}
                onSent={handleReplySent}
                onCancel={() => setShowReplyPanel(false)}
                fromEmail={fromEmail}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <Mail className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No email selected</h3>
              <p className="text-sm text-gray-500">
                Choose an email from the list to view and reply.
              </p>
              <div className="flex items-center justify-center gap-4 mt-5 text-xs text-gray-400">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-400"></span> Linked client
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-orange-400"></span> Potential lead
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400"></span> Your reply
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
