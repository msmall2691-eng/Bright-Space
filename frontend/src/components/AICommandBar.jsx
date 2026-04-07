import { useState, useRef, useEffect } from 'react'
import { Sparkles, X, Send, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { post, get } from '../api'

export default function AICommandBar() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState(null)
  const [followups, setFollowups] = useState(null)
  const inputRef = useRef(null)

  // Keyboard shortcut: Ctrl+K or Cmd+K
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      // Load follow-ups
      get('/api/ai/followup-check').then(setFollowups).catch(() => {})
    }
  }, [open])

  const ask = async () => {
    if (!query.trim() || loading) return
    setLoading(true)
    setAnswer(null)
    try {
      const page = window.location.pathname.replace('/', '') || 'dashboard'
      const res = await post('/api/ai/quick', { question: query, page_context: page })
      setAnswer(res)
    } catch (err) {
      setAnswer({ answer: 'Sorry, I could not process that right now. ' + (err.message || ''), error: true })
    }
    setLoading(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-3.5 py-2.5 bg-white text-gray-600 rounded-xl shadow-lg border border-gray-200 hover:border-gray-300 hover:shadow-xl transition-all group"
        title="AI Assistant (Ctrl+K)"
      >
        <Sparkles className="w-4 h-4 text-gray-400 group-hover:text-gray-600" />
        <span className="text-[12px] font-medium hidden sm:inline text-gray-500">Ask AI</span>
        <kbd className="hidden sm:inline text-[10px] text-gray-300 bg-gray-100 px-1.5 py-0.5 rounded ml-1">&#x2318;K</kbd>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl border border-gray-200/80 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <Sparkles className="w-5 h-5 text-amber-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask()}
            placeholder="Ask anything about your business..."
            className="flex-1 text-sm outline-none placeholder:text-gray-400"
          />
          {loading ? (
            <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
          ) : (
            <button onClick={ask} className="p-1 text-gray-400 hover:text-gray-700">
              <Send className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => setOpen(false)} className="p-1 text-gray-300 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Answer */}
        {answer && (
          <div className="px-5 py-4 border-b border-gray-100 max-h-60 overflow-y-auto">
            <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{answer.answer}</p>
          </div>
        )}

        {/* Follow-up Alerts */}
        {followups && followups.total > 0 && !answer && (
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Needs Attention</p>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {followups.followups.slice(0, 5).map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  {f.severity === 'high' ? (
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <span className="font-medium text-gray-800">{f.title}</span>
                    <p className="text-xs text-gray-500">{f.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Actions */}
        {!answer && (
          <div className="px-5 py-3">
            <p className="text-xs text-gray-400 mb-2">Try asking:</p>
            <div className="flex flex-wrap gap-2">
              {["How many jobs this week?", "Any unanswered messages?", "What's my revenue outlook?", "Who are my newest leads?"].map(q => (
                <button
                  key={q}
                  onClick={() => { setQuery(q); setTimeout(ask, 100) }}
                  className="text-xs px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-full border border-gray-200 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
