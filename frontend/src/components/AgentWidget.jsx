import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, X, RotateCcw, Sparkles, ChevronDown, Minimize2, Maximize2 } from 'lucide-react'
import { get, wsUrl } from '../api'

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
  const [expanded, setExpanded] = useState(false)
  const [activeAgent, setActiveAgent] = useState(null)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  // Set default agent based on page
  useEffect(() => {
    const defaultId = PAGE_AGENTS[pageContext] || 'nova'
    const agent = AGENTS.find(a => a.id === defaultId) || AGENTS[0]
    setActiveAgent(agent)
  }, [pageContext])

  const connect = useCallback((agent) => {
    if (wsRef.current) wsRef.current.close()
    const ws = new WebSocket(wsUrl(`/ws/agent/${agent.id}`))
    ws.onopen = () => {
      console.log(`[ws:${agent.id}] onopen`)
      setConnected(true)
    }
    ws.onclose = () => {
      console.log(`[ws:${agent.id}] onclose`)
      setConnected(false)
    }
    ws.onerror = () => {
      console.log(`[ws:${agent.id}] onerror`)
      setConnected(false)
    }
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      console.log(`[ws:${agent.id}] onmessage:`, data.type)
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
    return () => { if (!open) wsRef.current?.close() }
  }, [open, activeAgent, connect])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = (msg) => {
    const text = msg || input.trim()
    if (!text || !connected || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ message: text }))
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setInput('')
    inputRef.current?.focus()
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

  // Floating trigger button
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg border border-gray-200 bg-white hover:bg-gray-50 transition-all hover:shadow-xl group"
      >
        <span className="text-lg">{activeAgent.emoji}</span>
        <span className="text-sm font-medium text-gray-700">Ask {activeAgent.name}</span>
        <Sparkles className="w-3.5 h-3.5 text-gray-400 group-hover:text-amber-500 transition-colors" />
      </button>
    )
  }

  return (
    <div className={`fixed z-50 bg-white border border-gray-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
      expanded
        ? 'bottom-4 right-4 left-4 top-4 sm:left-auto sm:top-4 sm:w-[520px] sm:bottom-4'
        : 'bottom-4 right-4 w-[380px] h-[520px]'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Agent picker dropdown */}
          <button
            onClick={() => setShowAgentPicker(!showAgentPicker)}
            className="flex items-center gap-2 hover:bg-gray-100 rounded-lg px-2 py-1 transition-colors"
          >
            <span className="text-xl">{activeAgent.emoji}</span>
            <div className="text-left">
              <div className="text-sm font-semibold text-gray-900 leading-tight">{activeAgent.name}</div>
              <div className="text-[10px] text-gray-400">{activeAgent.role}</div>
            </div>
            <ChevronDown className="w-3 h-3 text-gray-400" />
          </button>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-300'}`} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={clearChat} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors" title="Clear chat">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded(!expanded)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors hidden sm:flex" title={expanded ? 'Minimize' : 'Expand'}>
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => { setOpen(false); wsRef.current?.close() }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors" title="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Agent picker dropdown menu */}
      {showAgentPicker && (
        <div className="absolute top-14 left-3 z-10 bg-white border border-gray-200 rounded-xl shadow-xl p-1.5 w-56">
          {AGENTS.map(agent => (
            <button
              key={agent.id}
              onClick={() => switchAgent(agent)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                activeAgent.id === agent.id ? 'bg-gray-100' : 'hover:bg-gray-50'
              }`}
            >
              <span className="text-lg">{agent.emoji}</span>
              <div>
                <div className="text-sm font-medium text-gray-900">{agent.name}</div>
                <div className="text-[10px] text-gray-400">{agent.role}</div>
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
            <p className="text-sm font-medium text-gray-900 mb-1">Ask {activeAgent.name}</p>
            <p className="text-xs text-gray-400 mb-4">{activeAgent.role} - ready to help on this page</p>
            {prompts.length > 0 && (
              <div className="w-full space-y-1.5">
                {prompts.map(q => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="w-full text-left text-xs text-gray-500 bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors"
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
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50 border border-gray-100 text-[11px] text-gray-400">
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
                  ? 'bg-gray-900 text-white rounded-br-sm'
                  : 'bg-gray-100 text-gray-800 rounded-bl-sm'
              }`}>
                {msg.content}
                {msg.streaming && <span className="inline-block w-1 h-3.5 bg-gray-400 animate-pulse ml-0.5 rounded" />}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-100 bg-white">
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
            className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 placeholder-gray-400 resize-none focus:outline-none focus:border-gray-300 transition-colors"
            style={{ maxHeight: '80px' }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || !connected}
            className="p-2 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed rounded-xl transition-colors shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
