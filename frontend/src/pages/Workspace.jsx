import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, RotateCcw, ChevronDown } from 'lucide-react'

const AGENTS_FALLBACK = [
  { id: 'nova',   name: 'Nova',   emoji: '⚡', role: 'Business Strategist', color: '#f59e0b', description: 'Growth strategy, new ideas, and system design' },
  { id: 'mia',    name: 'Mia',    emoji: '📋', role: 'Operations Manager',  color: '#3b82f6', description: 'Scheduling, dispatch, and daily operations' },
  { id: 'scout',  name: 'Scout',  emoji: '🎯', role: 'Sales & Growth',      color: '#10b981', description: 'Client leads, quoting, and conversions' },
  { id: 'finn',   name: 'Finn',   emoji: '💰', role: 'Finance & Payroll',   color: '#8b5cf6', description: 'Invoicing, payroll, and profitability' },
  { id: 'pixel',  name: 'Pixel',  emoji: '🔧', role: 'Tech Builder',        color: '#ec4899', description: 'Read and write code, fix bugs, build features' },
  { id: 'deploy', name: 'Deploy', emoji: '🚀', role: 'Deployment Engineer', color: '#f97316', description: 'Get BrightBase live so you can use it anywhere' },
]

function AgentCard({ agent, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left w-full ${
        selected
          ? 'border-opacity-60 bg-opacity-10'
          : 'border-gray-200 bg-gray-50 hover:bg-gray-100 hover:border-gray-300'
      }`}
      style={selected ? { borderColor: agent.color, backgroundColor: agent.color + '18' } : {}}
    >
      <span className="text-2xl">{agent.emoji}</span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-900">{agent.name}</div>
        <div className="text-xs text-gray-400 truncate">{agent.role}</div>
      </div>
    </button>
  )
}

const TOOL_LABELS = {
  get_business_snapshot:   '📊 Checking business data…',
  get_clients:             '👥 Looking up clients…',
  get_jobs:                '📅 Checking schedule…',
  get_recurring_schedules: '🔄 Reading recurring schedules…',
  check_system_health:     '🩺 Running system health check…',
  run_operation:           '⚙️ Executing operation…',
  read_file:               '📄 Reading file…',
  list_files:              '🗂 Browsing files…',
  search_code:             '🔍 Searching codebase…',
  write_file:              '✍️ Writing file…',
  edit_file:               '✏️ Editing file…',
  run_command:             '⚡ Running command…',
}

function Message({ msg }) {
  const isUser = msg.role === 'user'

  if (msg.role === 'tool_call') {
    return (
      <div className="flex justify-start mb-2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200/50 text-xs text-gray-500">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse shrink-0" />
          {TOOL_LABELS[msg.name] || `🔧 Calling ${msg.name}…`}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-sky-600 text-gray-900 rounded-br-sm'
            : 'bg-gray-100 text-gray-800 rounded-bl-sm'
        }`}
      >
        {msg.content}
        {msg.streaming && <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse ml-1 rounded" />}
      </div>
    </div>
  )
}

export default function Workspace() {
  const [agents, setAgents] = useState(AGENTS_FALLBACK)
  const [activeAgent, setActiveAgent] = useState(AGENTS_FALLBACK[0])
  const [conversations, setConversations] = useState({})  // {agentId: [messages]}
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(data => { if (data?.length) setAgents(data) })
      .catch(() => {})
  }, [])

  const connect = useCallback((agent) => {
    if (wsRef.current) {
      wsRef.current.close()
    }
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsHost = window.location.host
    const ws = new WebSocket(`${wsProto}://${wsHost}/ws/agent/${agent.id}`)
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)

      if (data.type === 'tool_call') {
        // Show a transient "thinking" pill
        setConversations(prev => ({
          ...prev,
          [agent.id]: [...(prev[agent.id] || []), { role: 'tool_call', name: data.name }],
        }))
      } else if (data.type === 'chunk') {
        setConversations(prev => {
          const msgs = [...(prev[agent.id] || [])]
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            msgs[msgs.length - 1] = { ...last, content: last.content + data.content }
          } else {
            msgs.push({ role: 'assistant', content: data.content, streaming: true })
          }
          return { ...prev, [agent.id]: msgs }
        })
      } else if (data.type === 'done') {
        setConversations(prev => {
          const msgs = [...(prev[agent.id] || [])]
            // Remove transient tool_call pills
            .filter(m => m.role !== 'tool_call')
          const last = msgs[msgs.length - 1]
          if (last?.streaming) msgs[msgs.length - 1] = { ...last, streaming: false }
          return { ...prev, [agent.id]: msgs }
        })
      } else if (data.type === 'error') {
        setConversations(prev => ({
          ...prev,
          [agent.id]: [...(prev[agent.id] || []), { role: 'error', content: data.content }],
        }))
      }
    }
    wsRef.current = ws
  }, [])

  useEffect(() => {
    connect(activeAgent)
    inputRef.current?.focus()
    return () => wsRef.current?.close()
  }, [activeAgent, connect])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversations, activeAgent])

  const sendMessage = () => {
    const msg = input.trim()
    if (!msg || !connected || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ message: msg }))
    setConversations(prev => ({
      ...prev,
      [activeAgent.id]: [...(prev[activeAgent.id] || []), { role: 'user', content: msg }],
    }))
    setInput('')
    inputRef.current?.focus()
  }

  const clearChat = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ clear: true }))
    }
    setConversations(prev => ({ ...prev, [activeAgent.id]: [] }))
  }

  const messages = conversations[activeAgent.id] || []

  return (
    <div className="flex h-full">
      {/* Agent picker */}
      <div className="w-52 bg-white border-r border-gray-200 flex flex-col p-3 gap-2 overflow-y-auto shrink-0">
        <p className="text-xs text-gray-500 font-medium px-1 pb-1">YOUR AGENTS</p>
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={activeAgent.id === agent.id}
            onClick={() => setActiveAgent(agent)}
          />
        ))}
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Agent header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white/50">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{activeAgent.emoji}</span>
            <div>
              <div className="font-semibold text-gray-900">{activeAgent.name}</div>
              <div className="text-xs text-gray-400">{activeAgent.role}</div>
            </div>
            <span
              className={`ml-2 w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`}
              title={connected ? 'Connected' : 'Disconnected'}
            />
          </div>
          <button
            onClick={clearChat}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-600 transition-colors px-2 py-1 rounded hover:bg-gray-100"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <span className="text-5xl mb-4">{activeAgent.emoji}</span>
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Chat with {activeAgent.name}</h3>
              <p className="text-sm text-gray-400 max-w-sm">{activeAgent.description}</p>
              <div className="mt-6 grid grid-cols-1 gap-2 w-full max-w-md">
                {activeAgent.id === 'nova' && [
                  'Give me a snapshot of the business right now',
                  'How can I grow my client base?',
                  'What should I charge for recurring cleans?',
                ].map(q => (
                  <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                    className="text-left text-sm text-gray-400 bg-gray-100 hover:bg-gray-200 px-4 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                    {q}
                  </button>
                ))}
                {activeAgent.id === 'mia' && [
                  "What jobs are coming up this week?",
                  "Which clients don't have recurring schedules yet?",
                  "Show me today's schedule",
                ].map(q => (
                  <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                    className="text-left text-sm text-gray-400 bg-gray-100 hover:bg-gray-200 px-4 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                    {q}
                  </button>
                ))}
                {activeAgent.id === 'deploy' && [
                  'What do I need to do to deploy BrightBase?',
                  'Check the codebase and tell me what needs to change for production',
                  'Walk me through deploying to Railway and Vercel step by step',
                ].map(q => (
                  <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                    className="text-left text-sm text-gray-400 bg-gray-100 hover:bg-gray-200 px-4 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                    {q}
                  </button>
                ))}
                {activeAgent.id === 'pixel' && [
                  'Check system health and fix any issues you find',
                  'Read the scheduling page and improve the job editing UX',
                  'Look at the invoicing module and build out the UI',
                ].map(q => (
                  <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                    className="text-left text-sm text-gray-400 bg-gray-100 hover:bg-gray-200 px-4 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <Message key={i} msg={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-gray-200 bg-white/50">
          <div className="flex gap-3 items-end">
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
              placeholder={`Ask ${activeAgent.name} anything...`}
              className="flex-1 bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-500 resize-none focus:outline-none focus:border-gray-400 transition-colors"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || !connected}
              className="p-3 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed rounded-xl transition-colors shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-1.5 ml-1">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>
    </div>
  )
}
