import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, X, RotateCcw, Sparkles, ChevronDown, Minimize2, Maximize2 } from 'lucide-react'
import { wsUrl } from '../api'

const AGENTS = [
  { id: 'nova',   name: 'Nova',   emoji: '⚡', role: 'Business Strategist', color: '#f59e0b' },
  { id: 'mia',    name: 'Mia',    emoji: '📋', role: 'Operations Manager',  color: '#3b82f6' },
  { id: 'scout',  name: 'Scout',  emoji: '🎯', role: 'Sales & Growth',      color: '#10b981' },
  { id: 'finn',   name: 'Finn',   emoji: '💰', role: 'Finance & Payroll',   color: '#8b5cf6' },
  { id: 'pixel',  name: 'Pixel',  emoji: '🔧', role: 'Tech Builder',        color: '#ec4899' },
]

const TOOL_LABELS = {
  get_business_snapshot:   '📊 Checking business data...',
  get_clients:             '👥 Looking up clients...',
  get_jobs:                '📅 Checking schedule...',
  get_recurring_schedules: '🔄 Reading recurring schedules...',
  check_system_health:     '🩺 Running health check...',
  run_operation:           '⚙️ Executing operation...',
  read_file:               '📄 Reading file...',
  list_files:              '🗂 Browsing files...',
  search_code:             '🔍 Searching codebase...',
  write_file:              '✍️ Writing file...',
  edit_file:               '✏️ Editing file...',
  run_command:             '⚡ Running command...',
}

// Map pages to their best-fit default agent
const PAGE_AGENTS = {
  dashboard: 'nova',
  clients: 'scout',
  requests: 'scout',
  pipeline: 'scout',
  quoting: 'scout',
  scheduling: 'mia',
  recurring: 'mia',
  properties: 'mia',
  invoicing: 'finn',
  payroll: 'finn',
  dispatch: 'mia',
  comms: 'scout',
  settings: 'pixel',
}

/**
 * Floating agent chat widget for any page.
 *
 * Props:
 *  - pageContext: string key (e.g. 'dashboard', 'clients')
 *  - prompts: string[] of suggested quick prompts
 *  - contextData: optional object with page data to include in context
 */
export default function AgentWidget({ pageContext = 'dashboard', prompts = [], contextData }) {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(() => localStorage.getItem('brightbase_hide_scout') === '1')
  const [expanded, setExpanded] = useState(false)
  const [activeAgent, setActiveAgent] = useState(null)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const pendingRef = useRef([])
  const bottomRef = useRef(null)

  // React to the Settings → General visibility toggle (same-tab custom event).
  useEffect(() => {
    const onVis = () => setHidden(localStorage.getItem('brightbase_hide_scout') === '1')
    window.addEventListener('scout-visibility', onVis)
    return () => window.removeEventListener('scout-visibility', onVis)
  }, [])
  const inputRef = useRef(null)

  // Set default agent based on page
  useEffect(() => {
    const defaultId = PAGE_AGENTS[pageContext] || 'nova'
    const agent = AGENTS.find(a => a.id === defaultId) || AGENTS[0]
    setActiveAgent(agent)
  }, [pageContext])

  const connect = useCallback((agent) => {
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      try { wsRef.current.close() } catch {}
    }
    const url = wsUrl(`/ws/agent/${agent.id}`)
    console.debug(`[widget:${agent.id}] connecting`, url)
    const ws = new WebSocket(url)

    ws.onopen = () => {
      console.debug(`[widget:${agent.id}] open`)
      setConnected(true)
      while (pendingRef.current.length) {
        const msg = pendingRef.current.shift()
        try { ws.send(JSON.stringify(msg)) } catch (e) { console.error('[widget] flush-send failed', e) }
      }
    }
    ws.onclose = (e) => {
      console.debug(`[widget:${agent.id}] close code=${e.code}`)
      setConnected(false)
    }
    ws.onerror = () => setConnected(false)

    ws.onmessage = (e) => {
      let data
      try { data = JSON.parse(e.data) } catch { return }

      if (data.type === 'tool_call') {
        setMessages(prev => [...prev, { role: 'tool_call', name: data.name }])
      } else if (data.type === 'chunk') {
        setMessages(prev => {
          const msgs = [...prev]
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            msgs[msgs.length - 1] = { ...last, content: last.content + data.content }
          } else {
            msgs.push({ role: 'assistant', content: data.content, streaming: true })
          }
          return msgs
        })
      } else if (data.type === 'done') {
        setMessages(prev =>
          prev.filter(m => m.role !== 'tool_call').map((m, i, arr) =>
            i === arr.length - 1 && m.streaming ? { ...m, streaming: false } : m
          )
        )
      } else if (data.type === 'error') {
        setMessages(prev => [...prev, { role: 'error', content: data.content }])
      }
    }
    wsRef.current = ws
  }, [])

  useEffect(() => {
    if (open && activeAgent) {
      connect(activeAgent)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
    return () => {
      // Only close the socket if the widget is closing or unmounting
      if (!open && wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close() } catch {}
      }
    }
  }, [open, activeAgent, connect])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = (explicit) => {
    const text = (explicit ?? input).trim()
    if (!text) return
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setInput('')
    inputRef.current?.focus()

    const payload = { message: text }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
    } else {
      pendingRef.current.push(payload)
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (activeAgent) connect(activeAgent)
      }
    }
  }

  const clearChat = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ clear: true }))
    }
    setMessages([])
  }

  const switchAgent = (agent) => {
    setActiveAgent(agent)
    setMessages([])
    setShowAgentPicker(false)
  }

  if (!activeAgent) return null

  // Dismissed by the user (re-enable in Settings → General).
  if (hidden) return null

  const hideScout = () => {
    localStorage.setItem('brightbase_hide_scout', '1')
    setHidden(true)
    window.dispatchEvent(new Event('scout-visibility'))
  }

  // Floating trigger button. Icon-only on mobile so it doesn't sit on top of the
  // page content; a small × dismisses it entirely.
  if (!open) {
    return (
      <div className="fixed bottom-[6.5rem] right-4 lg:bottom-5 lg:right-5 z-40 group/scout">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-3 sm:px-4 py-3 rounded-2xl shadow-lg border border-hairline bg-panel hover:bg-bg transition-all hover:shadow-xl group"
        >
          <span className="text-lg">{activeAgent.emoji}</span>
          <span className="hidden sm:inline text-sm font-medium text-ink-2">Ask {activeAgent.name}</span>
          <Sparkles className="w-3.5 h-3.5 text-ink-3 group-hover:text-amber-500 transition-colors" />
        </button>
        <button
          onClick={hideScout}
          title="Hide assistant (turn back on in Settings → General)"
          aria-label="Hide assistant"
          className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-bg-2 border border-hairline text-ink-3 hover:text-ink flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover/scout:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  return (
    <div className={`fixed z-50 bg-panel border border-hairline rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
      expanded
        ? 'bottom-4 right-4 left-4 top-4 sm:left-auto sm:top-4 sm:w-[520px] sm:bottom-4'
        : 'bottom-4 right-4 w-[380px] h-[520px]'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hairline bg-bg/80">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={() => setShowAgentPicker(!showAgentPicker)}
            className="flex items-center gap-2 hover:bg-bg-2 rounded-lg px-2 py-1 transition-colors"
          >
            <span className="text-xl">{activeAgent.emoji}</span>
            <div className="text-left">
              <div className="text-sm font-semibold text-ink leading-tight">{activeAgent.name}</div>
              <div className="text-[10px] text-ink-3">{activeAgent.role}</div>
            </div>
            <ChevronDown className="w-3 h-3 text-ink-3" />
          </button>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-ink-3'}`} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={clearChat} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors" title="Clear chat">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded(!expanded)} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors hidden sm:flex" title={expanded ? 'Minimize' : 'Expand'}>
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => { setOpen(false); wsRef.current?.close() }} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors" title="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Agent picker dropdown menu */}
      {showAgentPicker && (
        <div className="absolute top-14 left-3 z-10 bg-panel border border-hairline rounded-xl shadow-xl p-1.5 w-56">
          {AGENTS.map(agent => (
            <button
              key={agent.id}
              onClick={() => switchAgent(agent)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                activeAgent.id === agent.id ? 'bg-bg-2' : 'hover:bg-bg'
              }`}
            >
              <span className="text-lg">{agent.emoji}</span>
              <div>
                <div className="text-sm font-medium text-ink">{agent.name}</div>
                <div className="text-[10px] text-ink-3">{agent.role}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin" onClick={() => setShowAgentPicker(false)}>
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <span className="text-3xl mb-2">{activeAgent.emoji}</span>
            <p className="text-sm font-medium text-ink mb-1">Ask {activeAgent.name}</p>
            <p className="text-xs text-ink-3 mb-4">{activeAgent.role} - ready to help on this page</p>
            {prompts.length > 0 && (
              <div className="w-full space-y-1.5">
                {prompts.map(q => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="w-full text-left text-xs text-ink-3 bg-bg hover:bg-bg-2 px-3 py-2 rounded-lg border border-hairline hover:border-hairline transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => {
          if (msg.role === 'tool_call') {
            return (
              <div key={i} className="flex justify-start mb-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg border border-hairline text-[11px] text-ink-3">
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
                  {TOOL_LABELS[msg.name] || `🔧 ${msg.name}...`}
                </div>
              </div>
            )
          }
          if (msg.role === 'error') {
            return (
              <div key={i} className="mb-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100 text-xs text-red-600">
                {msg.content}
              </div>
            )
          }
          const isUser = msg.role === 'user'
          return (
            <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2.5`}>
              <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                isUser
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : 'bg-bg-2 text-ink-2 rounded-bl-sm'
              }`}>
                {msg.content}
                {msg.streaming && <span className="inline-block w-1 h-3.5 bg-ink-3 animate-pulse ml-0.5 rounded" />}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-hairline bg-panel">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder={`Ask ${activeAgent.name}...`}
            className="flex-1 bg-bg border border-hairline rounded-xl px-3 py-2 text-sm text-ink-2 placeholder-ink-3 resize-none focus:outline-none focus:border-hairline transition-colors"
            style={{ maxHeight: '80px' }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim()}
            className="p-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed rounded-xl transition-colors shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
