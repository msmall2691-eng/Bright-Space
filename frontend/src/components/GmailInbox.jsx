import { useState, useEffect, useRef } from 'react'
import { Mail, User, UserPlus, Paperclip, ArrowLeft, RefreshCw, Link2, ExternalLink, Clock, Inbox, Search } from 'lucide-react'
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

export default function GmailInbox() {
  const [emails, setEmails] = useState([])
  const [summary, setSummary] = useState({ total: 0, linked: 0, unlinked: 0, unread: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all') // all | linked | leads
  const [creating, setCreating] = useState(null) // email_id being processed
  const detailRef = useRef(null)

  const load = () => {
    setLoading(true)
    setError(null)
    get('/api/gmail/inbox?max_results=40&skip_automated=true')
      .then(data => {
        setEmails(data.emails || [])
        setSummary(data.summary || {})
        setLoading(false)
      })
      .catch(err => {
        console.error('Gmail fetch error:', err)
        setError('Could not load Gmail inbox. Check SMTP credentials.')
        setLoading(false)
      })
  }

  useEffect(() => { load() }, [])

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
        // Update email in list to show linked
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

  // Filter + search
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
    <div className="flex flex-1 h-full overflow-hidden">
      {/* Left: Email list */}
      <div className="w-[420px] border-r border-gray-200 flex flex-col bg-white">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-gray-700" />
              <h2 className="font-semibold text-gray-900">Gmail Inbox</h2>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search emails..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Filter pills */}
          <div className="flex gap-1.5">
            {[
              { key: 'all', label: 'All', count: summary.total },
              { key: 'linked', label: 'Clients', count: summary.linked },
              { key: 'leads', label: 'New Leads', count: summary.unlinked },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  filter === f.key
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {f.label} {f.count > 0 && <span className="ml-1 opacity-70">{f.count}</span>}
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
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              <Inbox className="w-5 h-5 mr-2" /> No emails found
            </div>
          ) : (
            filtered.map(em => (
              <div
                key={em.id}
                onClick={() => setSelected(em)}
                className={`px-4 py-3 border-b border-gray-100 cursor-pointer transition-colors ${
                  selected?.id === em.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                } ${!em.is_read ? 'bg-blue-50/30' : ''}`}
              >
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5 ${
                    em.is_known_contact
                      ? 'bg-green-100 text-green-700'
                      : 'bg-orange-100 text-orange-700'
                  }`}>
                    {em.is_known_contact
                      ? em.client?.name?.charAt(0)?.toUpperCase() || 'C'
                      : em.from_name?.charAt(0)?.toUpperCase() || '?'
                    }
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className={`text-sm truncate ${!em.is_read ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                        {em.is_known_contact ? em.client.name : em.from_name}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0 ml-2">{timeAgo(em.date)}</span>
                    </div>

                    <p className={`text-sm truncate mb-0.5 ${!em.is_read ? 'text-gray-900 font-medium' : 'text-gray-600'}`}>
                      {em.subject}
                    </p>

                    <div className="flex items-center gap-1.5">
                      <p className="text-xs text-gray-400 truncate flex-1">{em.snippet}</p>
                      <div className="flex items-center gap-1 shrink-0">
                        {em.has_attachments && <Paperclip className="w-3 h-3 text-gray-400" />}
                        {em.is_known_contact ? (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-50 text-green-600 rounded">Client</span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-50 text-orange-600 rounded">New</span>
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

      {/* Right: Email detail / empty state */}
      <div className="flex-1 flex flex-col bg-white overflow-hidden">
        {selected ? (
          <>
            {/* Detail header */}
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <button
                  onClick={() => setSelected(null)}
                  className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 lg:hidden"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
              </div>

              <h2 className="text-lg font-semibold text-gray-900 mb-2">{selected.subject}</h2>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold ${
                    selected.is_known_contact ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                  }`}>
                    {selected.is_known_contact
                      ? selected.client?.name?.charAt(0)?.toUpperCase() || 'C'
                      : selected.from_name?.charAt(0)?.toUpperCase() || '?'
                    }
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{selected.from_name}</span>
                      {selected.is_known_contact ? (
                        <a
                          href={`/clients?id=${selected.client.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 rounded-full hover:bg-green-100"
                        >
                          <Link2 className="w-3 h-3" />
                          {selected.client.name}
                        </a>
                      ) : (
                        <button
                          onClick={() => createLead(selected)}
                          disabled={creating === selected.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-orange-50 text-orange-700 rounded-full hover:bg-orange-100 disabled:opacity-50"
                        >
                          <UserPlus className="w-3 h-3" />
                          {creating === selected.id ? 'Creating...' : 'Create Lead'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{selected.from_email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Clock className="w-3.5 h-3.5" />
                  {formatDate(selected.date)}
                </div>
              </div>

              {selected.to && (
                <p className="text-xs text-gray-400 mt-2">
                  To: {selected.to}
                </p>
              )}
            </div>

            {/* Email body */}
            <div ref={detailRef} className="flex-1 overflow-y-auto px-6 py-5">
              <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap leading-relaxed">
                {selected.body || selected.snippet || '(No content)'}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <Mail className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-1">Select an email</h3>
              <p className="text-sm text-gray-500">
                Choose an email to read. Senders are auto-matched to your clients.
              </p>
              <div className="flex items-center justify-center gap-4 mt-4 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-400"></span> Linked to client
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-orange-400"></span> Potential lead
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
