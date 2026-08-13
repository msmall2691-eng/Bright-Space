import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Lock, AlertCircle, Zap, Loader, Eye, EyeOff, CheckCircle2 } from 'lucide-react'
import { post, setJWT } from '../api'

/**
 * AcceptInvite — the set-your-password landing at /accept-invite?token=…
 *
 * A newly-added crew member clicks the emailed link and lands here (a PUBLIC
 * route, rendered before the auth gate). They choose a password; we POST it with
 * the signed, single-use invite token to /api/auth/accept-invite, which returns
 * a real session. We store it exactly like Login does, then HARD-navigate into
 * the app so App re-reads localStorage and routes a cleaner straight to My Day.
 */
export default function AcceptInvite() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  // No token in the URL → the link is malformed; say so up front rather than
  // letting them fill in a password that can never submit.
  useEffect(() => {
    if (!token) setError('This invite link is missing its code. Ask the office to resend it.')
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Choose a password of at least 8 characters.'); return }
    if (password !== confirm) { setError('Those passwords don’t match.'); return }
    setLoading(true)
    try {
      const res = await post('/api/auth/accept-invite', { token, password })
      if (res?.access_token) {
        setJWT(res.access_token)
        localStorage.setItem('brightbase_user', JSON.stringify(res))
        setDone(true)
        // Full reload so App re-initialises from localStorage and lands a
        // cleaner on My Day (client-side navigate wouldn't re-read the token).
        setTimeout(() => window.location.assign('/'), 600)
      } else {
        setError('Something went wrong finishing your sign-in. Please try again.')
      }
    } catch (err) {
      setError(err?.message || 'This invite link is invalid or has expired.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="relative w-full max-w-md">
        <div className="bg-panel rounded-2xl border border-hairline shadow-glass p-8">
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Zap className="w-6 h-6 text-white" />
            </div>
          </div>

          {done ? (
            <div className="text-center">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
              <h1 className="text-2xl font-bold text-ink mb-1">You’re all set</h1>
              <p className="text-ink-3">Taking you to your schedule…</p>
            </div>
          ) : (
            <>
              <h1 className="text-3xl font-bold text-ink text-center mb-2">Set your password</h1>
              <p className="text-center text-ink-3 mb-8">
                Welcome to the crew at The Maine Cleaning Co. Choose a password to
                see your schedule and clock in from your phone.
              </p>

              {error && (
                <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700 font-medium">{error}</p>
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label htmlFor="pw" className="block text-sm font-semibold text-ink-2 mb-2">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 w-5 h-5 text-ink-3" />
                    <input
                      id="pw"
                      type={show ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading || !token}
                      className="w-full pl-10 pr-12 py-3 rounded-lg border border-hairline/50 bg-panel/50 hover:bg-panel/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShow(!show)}
                      className="absolute right-3 top-3 text-ink-3 hover:text-ink-2"
                    >
                      {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirm" className="block text-sm font-semibold text-ink-2 mb-2">Confirm password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 w-5 h-5 text-ink-3" />
                    <input
                      id="confirm"
                      type={show ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      placeholder="Re-enter your password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      disabled={loading || !token}
                      className="w-full pl-10 pr-4 py-3 rounded-lg border border-hairline/50 bg-panel/50 hover:bg-panel/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all disabled:opacity-50"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !token}
                  className="w-full mt-6 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <><Loader className="w-4 h-4 animate-spin" /><span>Setting up…</span></>
                  ) : (
                    <span>Set password &amp; sign in</span>
                  )}
                </button>
              </form>

              <p className="text-[11px] text-ink-3 text-center mt-6">
                This link is single-use and expires 7 days after it was sent.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
