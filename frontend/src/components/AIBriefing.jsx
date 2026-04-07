import { useState, useEffect } from 'react'
import { Sparkles, Loader2, AlertTriangle, ChevronRight, RefreshCw, Lightbulb, Zap } from 'lucide-react'
import { get, post } from '../api'

export function AIBriefing() {
  const [briefing, setBriefing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const loadBriefing = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await get('/api/ai/daily-briefing')
      setBriefing(data)
    } catch (err) {
      setError(err.message || 'Could not load briefing')
    }
    setLoading(false)
  }

  return (
    <div className="bg-white border border-gray-200/60 rounded-xl p-6 relative overflow-hidden">
      <div className="relative">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            <h3 className="text-lg font-semibold">AI Daily Briefing</h3>
          </div>
          <button
            onClick={loadBriefing}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 text-gray-600"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {briefing ? 'Refresh' : 'Generate'}
          </button>
        </div>

        {!briefing && !loading && !error && (
          <div className="text-center py-6">
            <Zap className="w-10 h-10 text-amber-400/50 mx-auto mb-3" />
            <p className="text-gray-900/60 text-sm mb-3">Get your personalized morning briefing</p>
            <button
              onClick={loadBriefing}
              className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-[13px] font-medium transition-colors"
            >
              Generate Briefing
            </button>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-3 py-8 justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
            <span className="text-gray-900/60 text-sm">Analyzing your business data...</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 py-4 text-red-300 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {briefing && !loading && (
          <div className="space-y-4">
            {briefing.greeting && (
              <p className="text-gray-900/80 text-sm leading-relaxed">{briefing.greeting}</p>
            )}
            {briefing.summary && (
              <p className="text-gray-900/70 text-sm leading-relaxed">{briefing.summary}</p>
            )}

            {briefing.priorities?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide mb-2">Priorities</p>
                <div className="space-y-1.5">
                  {briefing.priorities.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm text-gray-900/80">
                      <ChevronRight className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                      <span>{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {briefing.alerts?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">Alerts</p>
                {briefing.alerts.map((a, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-red-200">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{a}</span>
                  </div>
                ))}
              </div>
            )}

            {briefing.tip && (
              <div className="flex items-start gap-2 mt-3 pt-3 border-t border-gray-100">
                <Lightbulb className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-gray-900/60">{briefing.tip}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function AIFollowUps() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    get('/api/ai/followup-check')
      .then(setData)
      .catch(() => setData({ total: 0, followups: [] }))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return null
  if (!data || data.total === 0) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200/60 p-5">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-gray-900">
          {data.total} Item{data.total !== 1 ? 's' : ''} Need Attention
        </h3>
      </div>
      <div className="space-y-2">
        {data.followups.slice(0, 6).map((f, i) => (
          <div key={i} className="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${f.severity === 'high' ? 'bg-red-500' : 'bg-amber-400'}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{f.title}</p>
              <p className="text-xs text-gray-500 truncate">{f.action}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
