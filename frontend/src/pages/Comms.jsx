import { useState, useEffect } from 'react'
import { Send, MessageSquare, Mail, Phone, Search, User, Clock, ArrowUpRight, ArrowDownLeft } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post } from "../api"


export default function Comms() {
  const [messages, setMessages] = useState([])
  const [clients, setClients] = useState([])
  const [tab, setTab] = useState('sms')
  const [form, setForm] = useState({ to: '', body: '', client_id: '', subject: '' })
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [search, setSearch] = useState('')

  const loadMessages = () =>
    get('/api/comms/messages').then(setMessages).catch(err => console.error("[Comms]", err))

  useEffect(() => {
    loadMessages()
    get('/api/clients').then(setClients).catch(err => console.error("[Comms]", err))
  }, [])

  const clientName = (id) => clients.find(c => c.id === id)?.name || null

  const send = async () => {
    setSending(true); setResult(null)
    try {
      if (tab === 'email') {
        const data = await post('/api/comms/email', {
          to: form.to,
          subject: form.subject,
          body: form.body,
          client_id: form.client_id ? parseInt(form.client_id) : null,
        })
        setResult({ ok: true, msg: 'Email sent!' })
        setMessages(prev => [data, ...prev])
        setForm(f => ({ ...f, to: '', body: '', subject: '' }))
      } else {
        const data = await post('/api/comms/sms', {
          to: form.to,
          body: form.body,
          client_id: form.client_id ? parseInt(form.client_id) : null,
        })
        setResult({ ok: true, msg: 'SMS sent!' })
        setMessages(prev => [data, ...prev])
        setForm(f => ({ ...f, to: '', body: '' }))
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e.message || e) })
    }
    setSending(false)
  }

  const selectClient = (id) => {
    const c = clients.find(c => String(c.id) === String(id))
    if (tab === 'sms') {
      setForm(f => ({ ...f, client_id: id, to: c?.phone || f.to }))
    } else {
      setForm(f => ({ ...f, client_id: id, to: c?.email || f.to }))
    }
  }

  const filteredMessages = messages.filter(m => {
    const channelMatch = tab === 'sms' ? m.channel === 'sms' : m.channel === 'email'
    if (!channelMatch) return false
    if (!search) return true
    const name = clientName(m.client_id)?.toLowerCase() || ''
    return name.includes(search.toLowerCase()) ||
      (m.body || '').toLowerCase().includes(search.toLowerCase()) ||
      (m.to_addr || '').includes(search) ||
      (m.from_addr || '').includes(search)
  })

  const inboundCount = messages.filter(m => m.direction === 'inbound').length
  const outboundCount = messages.filter(m => m.direction === 'outbound').length

  return (
    <div className="flex flex-col sm:flex-row h-full">
      {/* Compose */}
      <div className="bg-white border-b sm:border-b-0 sm:border-r border-gray-200 flex flex-col shrink-0 p-4 sm:p-6 sm:w-96">
        <h2 className="font-semibold text-gray-900 mb-4">Send Message</h2>

        <div className="flex gap-1 mb-4 bg-gray-100 p-1 rounded-lg">
          <button onClick={() => { setTab('sms'); setForm(f => ({ ...f, to: '', body: '' })) }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === 'sms' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            <MessageSquare className="w-3.5 h-3.5" /> SMS
          </button>
          <button onClick={() => { setTab('email'); setForm(f => ({ ...f, to: '', body: '', subject: '' })) }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === 'email' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            <Mail className="w-3.5 h-3.5" /> Email
          </button>
        </div>

        <div className="space-y-3 flex-1">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Client (optional)</label>
            <select value={form.client_id} onChange={e => selectClient(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400">
              <option value="">No client linked</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{tab === 'sms' ? (c.phone ? ` · ${c.phone}` : '') : (c.email ? ` · ${c.email}` : '')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {tab === 'sms' ? 'To (phone number)' : 'To (email address)'}
            </label>
            <div className="relative">
              {tab === 'sms'
                ? <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                : <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              }
              <input value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))}
                placeholder={tab === 'sms' ? '+1 (555) 000-0000' : 'client@email.com'}
                className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>
          </div>
          {tab === 'email' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Subject</label>
              <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                placeholder="e.g. Your cleaning quote from Maine Cleaning Co."
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Message</label>
            <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={5}
              placeholder={tab === 'sms' ? 'Type your SMS...' : 'Email body...'}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400 resize-none" />
          </div>

          {result && (
            <div className={`text-sm px-3 py-2 rounded-lg border ${
              result.ok
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-red-50 text-red-700 border-red-200'
            }`}>
              {result.msg}
            </div>
          )}
        </div>

        <button onClick={send} disabled={sending || !form.to || !form.body || (tab === 'email' && !form.subject)}
          className="mt-4 flex items-center justify-center gap-2 w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
          {tab === 'sms' ? <MessageSquare className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
          {sending ? 'Sending...' : tab === 'sms' ? 'Send SMS' : 'Send Email'}
        </button>
      </div>

      {/* Message log */}
      <div className="flex-1 p-4 sm:p-6 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-gray-900">Message Log</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {filteredMessages.length} message{filteredMessages.length !== 1 ? 's' : ''}
              {inboundCount > 0 && ` · ${inboundCount} inbound`}
              {outboundCount > 0 && ` · ${outboundCount} outbound`}
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search messages..."
              className="bg-white border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-gray-400 w-48" />
          </div>
        </div>

        <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
          {filteredMessages.map(m => (
            <div key={m.id} className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl p-4 hover:border-gray-300 transition-colors">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                m.direction === 'outbound' ? 'bg-sky-50' : 'bg-green-50'
              }`}>
                {m.direction === 'outbound'
                  ? <ArrowUpRight className="w-4 h-4 text-sky-500" />
                  : <ArrowDownLeft className="w-4 h-4 text-green-500" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-gray-900">
                    {m.direction === 'outbound' ? m.to_addr : m.from_addr}
                  </span>
                  {m.client_id && (
                    <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                      {clientName(m.client_id)}
                    </span>
                  )}
                  <span className="text-[11px] text-gray-400 ml-auto flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(m.created_at).toLocaleString()}
                  </span>
                </div>
                {m.subject && <div className="text-xs font-medium text-gray-700 mb-0.5">{m.subject}</div>}
                <div className="text-sm text-gray-600">{m.body}</div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  m.channel === 'sms'
                    ? 'bg-purple-50 text-purple-600 border border-purple-200'
                    : 'bg-blue-50 text-blue-600 border border-blue-200'
                }`}>
                  {m.channel?.toUpperCase()}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                  m.direction === 'outbound'
                    ? 'bg-sky-50 text-sky-600'
                    : 'bg-green-50 text-green-600'
                }`}>
                  {m.direction}
                </span>
              </div>
            </div>
          ))}
          {filteredMessages.length === 0 && (
            <div className="text-center py-16">
              <MessageSquare className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              <div className="text-gray-500 font-medium mb-1">
                {search ? 'No matching messages' : `No ${tab} messages yet`}
              </div>
              <p className="text-sm text-gray-400">
                {search ? 'Try a different search term' : `Send your first ${tab === 'sms' ? 'SMS' : 'email'} using the compose panel`}
              </p>
            </div>
          )}
        </div>
      </div>

      <AgentWidget
        pageContext="comms"
        prompts={[
          'Draft a follow-up SMS for my recent leads',
          'What clients haven\'t heard from me recently?',
          'Help me write a thank-you message after a job',
        ]}
      />
    </div>
  )
}
