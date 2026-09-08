import { useState } from 'react'
import { Clock, LogOut, RefreshCw } from 'lucide-react'
import { get, logout } from '../api'

/**
 * Waiting room for self-signups that haven't been approved yet. A pending
 * user holds a valid identity token but every data endpoint rejects them
 * (403 pending_approval) — this is the only screen they get until an admin
 * approves the account in Settings → Users.
 */
export default function PendingApproval({ user, onApproved }) {
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState('')

  const checkAgain = async () => {
    setChecking(true)
    setNote('')
    try {
      const s = await get('/api/auth/session-status')
      if (s?.status === 'active') {
        onApproved?.({ ...user, status: 'active', role: s.role || user.role })
        return
      }
      if (s?.status === 'disabled') {
        setNote('This account has been disabled. Contact your administrator.')
      } else {
        setNote('Still waiting — your administrator hasn’t approved this account yet.')
      }
    } catch {
      setNote('Could not check right now. Try again in a moment.')
    }
    setChecking(false)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-bg p-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-bg-2 border border-hairline flex items-center justify-center mb-5">
        <Clock className="w-7 h-7 text-ink-2" />
      </div>
      <h1 className="text-xl font-semibold text-ink mb-2">Waiting for approval</h1>
      <p className="text-sm text-ink-3 max-w-sm mb-1">
        Your account <span className="font-medium text-ink-2">{user?.email}</span> was created
        and is waiting for an administrator to approve it.
      </p>
      <p className="text-xs text-ink-3 max-w-sm mb-6">You'll get access as soon as they do.</p>
      {/* A quiet card with a dot, never a tinted fill (design language). Amber
          because it wants a second's notice, not alarm. */}
      {note && (
        <div className="flex items-start gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 mb-4 max-w-sm text-left text-xs text-ink-2">
          <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{note}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button onClick={checkAgain} disabled={checking}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <button onClick={logout}
          className="flex items-center gap-2 bg-panel border border-hairline hover:bg-bg-2 text-ink-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </div>
    </div>
  )
}
