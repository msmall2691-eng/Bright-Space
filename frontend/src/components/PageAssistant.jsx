import { useState, useRef, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X, Send, Loader2, Sparkles, ArrowUpRight, ChevronRight } from 'lucide-react'
import { get, post } from '../api'
import AgentAvatar from './workspace/AgentAvatar'
import MarkdownContent from './workspace/MarkdownContent'

/**
 * PageAssistant — a per-page AI "corner box" (desktop). Each section of the app
 * is owned by the agent that works it (Scout for sales/clients, Mia for ops/
 * schedule/comms, Finn for money, Nova otherwise). The box shows who's on the
 * page, a quick rundown of what needs attention (deterministic followup-check,
 * deep-linked), and a quick-ask input. It escalates to the full Workspace chat.
 *
 * Mobile keeps the simpler Ctrl+K AICommandBar (this is hidden below lg).
 */

// Route prefix → agent id + which followup severities/keywords belong to it.
const PAGE_AGENT = [
  { match: /^\/(billing|payroll|invoic)/, id: 'finn' },
  { match: /^\/(clients|pipeline|requests|quot|properties)/, id: 'scout' },
  { match: /^\/(schedule|recurring|comms|dispatch)/, id: 'mia' },
]
const DEFAULT_AGENT_ID = 'nova'

// Local fallbacks so the box still labels the agent if /api/agents is slow.
const FALLBACK = {
  finn:  { id: 'finn',  name: 'Finn',  emoji: '💰', role: 'Finance & Payroll',   color: '#22c55e' },
  scout: { id: 'scout', name: 'Scout', emoji: '🎯', role: 'Sales & Growth',      color: '#3b82f6' },
  mia:   { id: 'mia',   name: 'Mia',   emoji: '📋', role: 'Operations Manager',  color: '#a855f7' },
  nova:  { id: 'nova',  name: 'Nova',  emoji: '⚡', role: 'Business Strategist', color: '#6366f1' },
}

function agentIdForPath(path) {
  return (PAGE_AGENT.find(p => p.match.test(path)) || {}).id || DEFAULT_AGENT_ID
}

export default function PageAssistant() {
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [roster, setRoster] = useState(null)
  const [followups, setFollowups] = useState(null)
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState(null)
  const inputRef = useRef(null)

  const agentId = agentIdForPath(location.pathname)
  const agent = useMemo(
    () => (roster || []).find(a => a.id === agentId) || FALLBACK[agentId] || FALLBACK.nova,
    [roster, agentId],
  )

  // Roster once; follow-ups whenever the box opens (cheap, deterministic).
  useEffect(() => { get('/api/agents').then(setRoster).catch(() => {}) }, [])
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    get('/api/ai/followup-check').then(setFollowups).catch(() => setFollowups({ followups: [] }))
  }, [open])
  // Reset the transient answer when navigating to a new page.
  useEffect(() => { setAnswer(null); setQuery('') }, [location.pathname])

  // Show the rundown items most relevant to this page first, then the rest.
  const items = useMemo(() => {
    const all = followups?.followups || []
    const here = all.filter(f => (f.href || '').startsWith('/' + (location.pathname.split('/')[1] || '')))
    const rest = all.filter(f => !here.includes(f))
    return [...here, ...rest].slice(0, 4)
  }, [followups, location.pathname])

  const ask = async () => {
    if (!query.trim() || asking) return
    setAsking(true); setAnswer(null)
    try {
      const page = location.pathname.replace('/', '') || 'dashboard'
      const res = await post('/api/ai/quick', { question: query, page_context: page })
      setAnswer(res)
    } catch (err) {
      setAnswer({ answer: 'Sorry — I couldn’t answer that right now.', error: true })
    }
    setAsking(false)
  }

  // Collapsed pill — labels the section's agent.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title={`${agent.name} · your ${agent.role} for this page`}
        className="no-print hidden lg:flex fixed bottom-6 right-6 z-40 items-center gap-2 pl-2 pr-3.5 py-2 bg-panel rounded-full shadow-lg border border-hairline hover:border-hairline-2 hover:shadow-xl transition-all group"
      >
        <AgentAvatar agent={agent} size="sm" />
        <span className="text-left leading-tight">
          <span className="block text-[12px] font-semibold text-ink">{agent.name}</span>
          <span className="block text-[10px] text-ink-3 -mt-0.5">Ask · view rundown</span>
        </span>
        <Sparkles className="w-3.5 h-3.5 text-ink-3 group-hover:text-blue-500" />
      </button>
    )
  }

  return (
    <div className="no-print hidden lg:flex flex-col fixed bottom-6 right-6 z-40 w-[360px] max-h-[70vh] bg-panel rounded-2xl shadow-2xl border border-hairline overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-hairline">
        <AgentAvatar agent={agent} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink leading-tight">{agent.name}</p>
          <p className="text-[11px] text-ink-3 leading-tight">Your {agent.role} for this page</p>
        </div>
        <button onClick={() => navigate('/workspace')} title="Open full chat"
          className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors">
          <ArrowUpRight className="w-4 h-4" />
        </button>
        <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
        {/* Rundown */}
        <div>
          <p className="text-[10px] font-bold text-ink-3 uppercase tracking-wider px-1 mb-1.5">Rundown</p>
          {!followups ? (
            <div className="flex items-center gap-2 text-[12px] text-ink-3 px-1 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…</div>
          ) : items.length === 0 ? (
            <p className="text-[12px] text-ink-3 px-1 py-1.5">All clear — nothing needs you right now. ✨</p>
          ) : (
            <div className="space-y-1">
              {items.map((f, i) => (
                <button key={i} onClick={() => { if (f.href) navigate(f.href) }}
                  className="w-full text-left flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-2 transition-colors group">
                  <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                    f.severity === 'high' ? 'bg-red-500' : f.severity === 'medium' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-ink truncate">{f.title}</span>
                    {f.detail && <span className="block text-[11px] text-ink-3 truncate">{f.detail}</span>}
                  </span>
                  {f.href && <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0 mt-0.5 group-hover:text-ink-2" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Answer */}
        {(asking || answer) && (
          <div className="rounded-lg border border-hairline bg-bg-2/50 p-2.5">
            {asking ? (
              <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {agent.name} is thinking…</div>
            ) : (
              <MarkdownContent text={answer.answer || 'No answer.'} />
            )}
          </div>
        )}
      </div>

      {/* Ask input */}
      <div className="border-t border-hairline p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
            rows={1}
            placeholder={`Ask ${agent.name} about this page…`}
            className="flex-1 resize-none bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-blue-400 max-h-24"
          />
          <button onClick={ask} disabled={!query.trim() || asking}
            className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white shrink-0">
            {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
