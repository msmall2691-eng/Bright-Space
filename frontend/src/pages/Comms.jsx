import { useState, useEffect } from 'react'
import { Send, MessageSquare, Mail, Phone } from 'lucide-react'

export default function Comms() {
  const [messages, setMessages] = useState([])
  const [clients, setClients] = useState([])
  const [tab, setTab] = useState('sms')
  const [form, setForm] = useState({ to: '', body: '', client_id: '', subject: '' })
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    fetch('/api/comms/messages').then(r => r.json()).then(setMessages).catch(() => {})
    fetch('/api/clients').then(r => r.json()).then(setClients).catch(() => {})
  }, [])

  const clientName = (id) => clients.find(c => c.id === id)?.name || null

  const send = async () => {
    setSending(true); setResult(null)
    try {
      const r = await fetch('/api/comms/sms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: form.to, body: form.body, client_id: form.client_id ? parseInt(form.client_id) : null }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed')
      setResult({ ok: true, msg: 'SMS sent!' })
      setMessages(prev => [data, ...prev])
      setForm(f => ({ ...f, to: '', body: '' }))
    } catch (e) {
      setResult({ ok: false, msg: String(e.message || e) })
    }
    setSending(false)
  }

  const selectClient = (id) => {
    const c = clients.find(c => String(c.id) === String(id))
    setForm(f => ({ ...f, client_id: id, to: c?.phone || f.to }))
  }

  const smsMessages = messages.filter(m => m.channel === 'sms')

  return (
    <div className="flex h-full">
      {/* Compose */}
      <div className="w-96 bg-white border-r border-gray-200 flex flex-col shrink-0 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Send Message</h2>

        <div className="flex gap-2 mb-4">
          <button onClick={() => setTab('sms')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === 'sms' ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400'}`}>
            <MessageSquare className="w-3.5 h-3.5" />SMS
          </button>
          <button onClick={() => setTab('email')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === 'email' ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400'}`}>
            <Mail className="w-3.5 h-3.5" />Email
          </button>
        </div>

        <div className="space-y-3 flex-1">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Client (optional)</label>
            <select value={form.client_id} onChange={e => selectClient(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
              <option value="">No client linked</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              {tab === 'sms' ? 'To (phone number)' : 'To (email)'}
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))}
                placeholder={tab === 'sms' ? '+1 (555) 000-0000' : 'client@email.com'}
                className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>
          </div>
          {tab === 'email' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Subject</label>
              <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Message</label>
            <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={5}
              placeholder={tab === 'sms' ? 'Type your SMS...' : 'Email body...'}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400 resize-none" />
          </div>

          {result && (
            <div className={`text-sm px-3 py-2 rounded-lg ${result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
              {result.msg}
            </div>
          )}

          {tab === 'email' && (
            <div className="text-xs text-gray-500 bg-gray-100 rounded-lg p-3">
              Email sending coming soon — add SendGrid or SMTP credentials to enable.
            </div>
          )}
        </div>

        {tab === 'sms' && (
          <button onClick={send} disabled={sending || !form.to || !form.body}
            className="mt-4 flex items-center justify-center gap-2 w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
            <Send className="w-4 h-4" />{sending ? 'Sending...' : 'Send SMS'}
          </button>
        )}
      </div>

      {/* Message log */}
      <div className="flex-1 p-6 flex flex-col min-w-0">
        <h2 className="font-semibold text-gray-900 mb-4">Message Log</h2>
        <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
          {smsMessages.map(m => (
            <div key={m.id} className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl p-4">
              <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${m.direction === 'outbound' ? 'bg-sky-400' : 'bg-green-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-gray-900">
                    {m.direction === 'outbound' ? `→ ${m.to_addr}` : `← ${m.from_addr}`}
                  </span>
                  {m.client_id && <span className="text-xs text-gray-500">{clientName(m.client_id)}</span>}
                  <span className="text-xs text-gray-600 ml-auto">{new Date(m.created_at).toLocaleString()}</span>
                </div>
                <div className="text-sm text-gray-600">{m.body}</div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${m.direction === 'outbound' ? 'bg-sky-500/20 text-sky-400' : 'bg-green-500/20 text-green-400'}`}>
                {m.direction}
              </span>
            </div>
          ))}
          {smsMessages.length === 0 && <div className="text-center py-16 text-gray-500">No messages yet</div>}
        </div>
      </div>
    </div>
  )
}
