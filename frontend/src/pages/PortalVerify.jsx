import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Sparkles, AlertCircle } from 'lucide-react'

/**
 * PortalVerify — the magic-link landing at /portal/verify?token=…
 * Exchanges the one-time token for a portal session, stores it, and bounces to
 * /portal. Shows a friendly error if the link is expired or already used.
 */
const TOKEN_KEY = 'bb_portal_token'

export default function PortalVerify() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) { setError('This sign-in link is missing its code.'); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.fetch('/api/portal/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { if (!cancelled) setError(data.detail || 'This link is invalid or expired.'); return }
        localStorage.setItem(TOKEN_KEY, data.token)
        if (!cancelled) navigate('/portal', { replace: true })
      } catch {
        if (!cancelled) setError('Something went wrong. Please try signing in again.')
      }
    })()
    return () => { cancelled = true }
  }, [params, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-200 p-7 text-center">
        {error ? (
          <>
            <span className="grid place-items-center w-12 h-12 rounded-2xl bg-red-50 text-red-500 mx-auto mb-3">
              <AlertCircle className="w-6 h-6" />
            </span>
            <h1 className="text-lg font-bold text-slate-900">Couldn't sign you in</h1>
            <p className="text-sm text-slate-500 mt-1.5">{error}</p>
            <a href="/portal" className="mt-4 inline-block text-sm font-semibold text-violet-600 hover:text-violet-700">
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <span className="grid place-items-center w-12 h-12 rounded-2xl bg-violet-600 text-white mx-auto mb-3 animate-pulse">
              <Sparkles className="w-6 h-6" />
            </span>
            <h1 className="text-lg font-bold text-slate-900">Signing you in…</h1>
            <p className="text-sm text-slate-500 mt-1.5">One moment while we verify your link.</p>
          </>
        )}
      </div>
    </div>
  )
}
