import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { get } from '../api'

export function AIFollowUps({ title, className = '' }) {
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
    <div className={`bg-panel rounded-2xl border border-hairline p-5 ${className}`}>
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-ink">
          {title || `${data.total} Item${data.total !== 1 ? 's' : ''} Need Attention`}
        </h3>
      </div>
      <div className="space-y-2">
        {data.followups.slice(0, 6).map((f, i) => {
          // Each row lands the user on the queue for that finding. Non-link
          // rows (older backends without href, or one-offs) fall back to a
          // plain div so we never break when a follow-up ships without one.
          const inner = (
            <>
              <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${f.severity === 'high' ? 'bg-red-500' : 'bg-amber-400'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-2 truncate">{f.title}</p>
                <p className="text-xs text-ink-3 truncate">{f.action}</p>
              </div>
              {f.href && <ArrowRight className="w-3.5 h-3.5 text-ink-3 shrink-0 mt-1.5" />}
            </>
          )
          if (f.href) {
            return (
              <Link key={i} to={f.href} className="flex items-start gap-3 p-2 rounded-lg hover:bg-bg transition-colors">
                {inner}
              </Link>
            )
          }
          return (
            <div key={i} className="flex items-start gap-3 p-2 rounded-lg">
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}
