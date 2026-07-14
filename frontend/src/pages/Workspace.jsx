import { useEffect, useRef, useState } from 'react'
import { Sparkles, Send, ShieldAlert, ShieldCheck, Wrench } from 'lucide-react'
import PageHeader from '../components/ui/PageHeader'
import { EmptyState, Skeleton } from '../components/ui'
import AgentAvatar from '../components/workspace/AgentAvatar'
import { get, post, wsUrl } from '../api'

/**
 * Workspace — the Agent Command Center, rebuilt as a native chat room.
 *
 * Replaces the old dead external iframe (a claude.site public artifact with
 * no connection to BrightBase's data) with the app's own field-agent team —
 * Nova/Mia/Scout/Finn/Pixel/Deploy — talked to over the existing
 * /ws/agent/{agent_name} WebSocket (main.py), which was already fully wired
 * up server-side but had no UI pointed at it.
 *
 * Three things sit on top of that per-persona chat:
 *   1. ROUTING   — "Auto" mode posts the message to POST /api/ai/route,
 *                  which picks the best-fit field agent for the question.
 *   2. MODEL TIER — the same routing call also picks how much model the
 *                  reply is worth (haiku/sonnet/opus), so cost tracks task
 *                  difficulty instead of every message paying top rate.
 *   3. QC         — after each agent turn, a fast automatic review checks
 *                  the reply for correctness/security red flags and shows
 *                  a small badge under the message. This is IN ADDITION to
 *                  each persona's own "ask before acting" rule before it
 *                  writes files or runs commands — not a replacement for
 *                  your own confirmation on anything destructive.
 */

let bubbleSeq = 0
const nextId = () => `b${++bubbleSeq}`

const MODEL_LABEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

function RoutingChip({ agent, model, reasoning }) {
  return (
    <div className="flex justify-center my-2">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-3 bg-bg-2 border border-hairline rounded-full px-3 py-1">
        <Sparkles className="w-3 h-3" />
        {agent ? (
          <span>
            Routed to <span className="font-semibold text-ink-2">{agent.name}</span>
            {' '}({agent.role}) · {MODEL_LABEL[model] || model}
          </span>
        ) : (
          <span>Routing…</span>
        )}
        {reasoning && <span className="hidden sm:inline text-ink-3">— {reasoning}</span>}
      </div>
    </div>
  )
}

function ToolNotice({ agent, name }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-ink-3 pl-11 mt-1">
      <Wrench className="w-3 h-3 shrink-0" />
      <span>{agent?.name || 'Agent'} used <code className="text-ink-2">{name}</code></span>
    </div>
  )
}

function QcBadge({ qc }) {
  if (!qc || !qc.verdict) return null
  const flagged = qc.verdict === 'flag'
  const Icon = flagged ? ShieldAlert : ShieldCheck
  return (
    <div className={`flex items-center gap-1 text-[10px] mt-1.5 ${flagged ? 'text-amber-600' : 'text-ink-3'}`}>
      <Icon className="w-3 h-3" />
      <span>{flagged ? (qc.note || 'Flagged for review') : 'Reviewed'}</span>
    </div>
  )
}

function AgentBubble({ msg, agent }) {
  return (
    <div className="flex items-start gap-2.5 mt-3 max-w-[92%] sm:max-w-[80%]">
      <AgentAvatar agent={agent} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-ink-2">{agent?.name || 'Agent'}</span>
          {agent?.role && <span className="text-[10px] text-ink-3 hidden sm:inline">{agent.role}</span>}
        </div>
        <div
          className="mt-1 px-3.5 py-2.5 rounded-2xl rounded-tl-md bg-panel border border-hairline text-[13px] text-ink leading-relaxed whitespace-pre-wrap break-words"
          style={agent?.color ? { borderLeftColor: agent.color, borderLeftWidth: '3px' } : undefined}
        >
          {msg.text || (msg.streaming ? '…' : '')}
        </div>
        {msg.tools?.map((t, i) => <ToolNotice key={i} agent={agent} name={t} />)}
        <QcBadge qc={msg.qc} />
      </div>
    </div>
  )
}

function UserBubble({ text }) {
  return (
    <div className="flex justify-end mt-3">
      <div className="max-w-[85%] sm:max-w-[70%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-blue-600 text-white text-[13px] leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  )
}

function ErrorBubble({ text }) {
  return (
    <div className="flex justify-center my-2">
      <div className="text-[12px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-1.5">
        {text}
      </div>
    </div>
  )
}

export default function Workspace() {
  const [agents, setAgents] = useState([])
  const [loadingAgents, setLoadingAgents] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState(null) // null = Auto
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const wsMapRef = useRef({}) // `${agentId}:${model}` -> WebSocket
  const scrollRef = useRef(null)

  useEffect(() => {
    get('/api/agents').then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => setAgents([]))
      .finally(() => setLoadingAgents(false))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => () => {
    // Close every open agent socket when leaving the page.
    Object.values(wsMapRef.current).forEach(ws => { try { ws.close() } catch { /* ignore */ } })
  }, [])

  const agentById = (id) => agents.find(a => a.id === id)

  const patchMessage = (id, patch) => {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch(m) } : m)))
  }

  function openSocket(agentId, model) {
    const key = `${agentId}:${model}`
    const existing = wsMapRef.current[key]
    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl(`/ws/agent/${agentId}?model=${model}`))
      const onOpen = () => { resolve(socket) }
      const onError = (e) => reject(e)
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', () => {
        if (wsMapRef.current[key] === socket) delete wsMapRef.current[key]
      })
      wsMapRef.current[key] = socket
    })
  }

  async function sendToAgent(agentId, model, text, routing) {
    const bubbleId = nextId()
    setMessages(prev => [...prev, { id: bubbleId, kind: 'agent', agentId, text: '', tools: [], streaming: true }])

    let socket
    try {
      socket = await openSocket(agentId, model)
    } catch {
      patchMessage(bubbleId, () => ({ streaming: false, error: true, text: '' }))
      setMessages(prev => [...prev, { id: nextId(), kind: 'error', text: `Couldn't reach ${agentById(agentId)?.name || agentId}. Check the connection and try again.` }])
      setSending(false)
      return
    }

    // Guards against a socket that closes mid-turn (backend restart, proxy
    // timeout, provider hiccup) with no "done"/"error" frame ever arriving —
    // without this, the bubble stays "streaming" and the input stays
    // disabled until the page is reloaded.
    let turnDone = false
    const finishTurn = (patch) => {
      if (turnDone) return
      turnDone = true
      socket.removeEventListener('close', onCloseEarly)
      patchMessage(bubbleId, patch)
      setSending(false)
    }
    const onCloseEarly = () => {
      finishTurn((m) => ({
        streaming: false,
        text: m.text || 'Connection closed before a response finished. Please try again.',
      }))
    }
    socket.addEventListener('close', onCloseEarly)

    socket.onmessage = (evt) => {
      let data
      try { data = JSON.parse(evt.data) } catch { return }
      if (data.type === 'chunk') {
        patchMessage(bubbleId, (m) => ({ text: (m.text || '') + data.content }))
      } else if (data.type === 'tool_call') {
        patchMessage(bubbleId, (m) => ({ tools: [...(m.tools || []), data.name] }))
      } else if (data.type === 'qc') {
        patchMessage(bubbleId, () => ({ qc: { verdict: data.verdict, note: data.note } }))
      } else if (data.type === 'done') {
        finishTurn(() => ({ streaming: false }))
      } else if (data.type === 'error') {
        finishTurn((m) => ({ streaming: false, text: m.text || data.content }))
      }
    }

    socket.send(JSON.stringify({ message: text }))
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    setMessages(prev => [...prev, { id: nextId(), kind: 'user', text }])

    if (selectedAgentId) {
      // Manual pick: talk to that specialist directly at the reliable default tier.
      await sendToAgent(selectedAgentId, 'sonnet', text, null)
      return
    }

    // Auto mode: ask the router which agent + model tier fits this message.
    const routingId = nextId()
    setMessages(prev => [...prev, { id: routingId, kind: 'routing', agent: null, model: null }])
    try {
      const route = await post('/api/ai/route', { message: text })
      const agent = agentById(route.agent_id)
      setMessages(prev => prev.map(m => (m.id === routingId
        ? { ...m, agent, model: route.model, reasoning: route.reasoning }
        : m)))
      await sendToAgent(route.agent_id, route.model, text, route)
    } catch {
      setMessages(prev => prev.filter(m => m.id !== routingId))
      setMessages(prev => [...prev, { id: nextId(), kind: 'error', text: "Couldn't route your message. Try picking an agent directly below." }])
      setSending(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="h-full w-full bg-bg flex flex-col">
      <PageHeader
        title="Workspace"
        subtitle="Chat with your agent team — Nova, Mia, Scout, Finn, Pixel & Deploy"
        icon={Sparkles}
        iconColor="purple"
      />

      <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-8 pb-4">
        {/* Agent picker strip */}
        <div className="shrink-0 flex items-center gap-2 overflow-x-auto pb-3 -mx-1 px-1 scrollbar-thin">
          <button
            onClick={() => setSelectedAgentId(null)}
            className={`flex items-center gap-1.5 shrink-0 pl-1.5 pr-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors ${
              !selectedAgentId ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-panel border-hairline text-ink-2 hover:border-hairline-2'
            }`}
          >
            <span className="grid place-items-center w-6 h-6 rounded-full bg-purple-100 text-purple-600 text-xs">✨</span>
            Auto
          </button>
          {loadingAgents ? (
            <Skeleton className="h-8 w-40 rounded-full shrink-0" />
          ) : agents.map(a => (
            <button
              key={a.id}
              onClick={() => setSelectedAgentId(a.id === selectedAgentId ? null : a.id)}
              className={`flex items-center gap-1.5 shrink-0 pl-1.5 pr-3 py-1.5 rounded-full border text-[12px] font-semibold transition-colors ${
                selectedAgentId === a.id ? 'border-hairline-2' : 'bg-panel border-hairline text-ink-2 hover:border-hairline-2'
              }`}
              style={selectedAgentId === a.id ? { backgroundColor: `${a.color}14`, color: a.color, borderColor: `${a.color}55` } : undefined}
            >
              <AgentAvatar agent={a} size="sm" />
              {a.name}
            </button>
          ))}
        </div>

        {/* Message list */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Ask your team anything"
              description={selectedAgentId
                ? `Talking to ${agentById(selectedAgentId)?.name || '...'} — ${agentById(selectedAgentId)?.description || ''}`
                : "Leave it on Auto and the right specialist (business strategy, ops, sales, finance, or tech) picks up the question — or tap an agent above to talk to them directly."}
              compact
            />
          ) : (
            <div className="pb-2">
              {messages.map(m => {
                if (m.kind === 'user') return <UserBubble key={m.id} text={m.text} />
                if (m.kind === 'routing') return <RoutingChip key={m.id} agent={m.agent} model={m.model} reasoning={m.reasoning} />
                if (m.kind === 'error') return <ErrorBubble key={m.id} text={m.text} />
                return <AgentBubble key={m.id} msg={m} agent={agentById(m.agentId)} />
              })}
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="shrink-0 pt-3 pb-safe">
          <div className="flex items-end gap-2 bg-panel border border-hairline rounded-2xl p-2 shadow-sm">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={selectedAgentId ? `Message ${agentById(selectedAgentId)?.name || 'agent'}…` : 'Ask your team anything…'}
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none max-h-32"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="shrink-0 grid place-items-center w-9 h-9 rounded-full bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
