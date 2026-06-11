import { useState, useEffect, useCallback } from 'react'
import { Mail, Calendar, Link2, Unlink, AlertTriangle, CheckCircle } from 'lucide-react'
import { get, patch, del } from '../api'

/**
 * "Your Google account" — the per-user Gmail + Calendar grant (Twenty-style
 * connected account). Each member connects their OWN Google account; tokens
 * are stored encrypted server-side. Distinct from the legacy shared
 * "Connect Google" business-calendar card, which stays as a fallback.
 */
export default function GoogleAccountCard() {
  const [acct, setAcct] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // {tone:'ok'|'warn', msg}

  const load = useCallback(() => {
    get('/api/auth/google-account')
      .then(setAcct)
      .catch(() => setAcct(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    // Surface the connect-callback outcome (?google_account=connected|failed|…)
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('google_account')
    if (outcome) {
      setNotice(outcome === 'connected'
        ? { tone: 'ok', msg: 'Google account connected ✓ Gmail and Calendar sync are on.' }
        : { tone: 'warn', msg: `Connecting failed (${outcome.replace(/_/g, ' ')}). Try again.` })
      params.delete('google_account')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [load])

  const connect = async () => {
    setBusy(true)
    try {
      const r = await get('/api/auth/google-account/connect-url')
      if (r?.auth_url) { window.location.href = r.auth_url; return }
      setNotice({ tone: 'warn', msg: 'Could not start the Google consent flow.' })
    } catch (e) {
      setNotice({ tone: 'warn', msg: e.message || 'Could not start the Google consent flow.' })
    }
    setBusy(false)
  }

  const disconnect = async () => {
    if (!window.confirm('Disconnect your Google account? Gmail and Calendar sync from this account will stop.')) return
    setBusy(true)
    try {
      await del('/api/auth/google-account')
      setNotice({ tone: 'ok', msg: 'Disconnected.' })
      load()
    } catch (e) {
      setNotice({ tone: 'warn', msg: e.message || 'Disconnect failed' })
    }
    setBusy(false)
  }

  const toggle = async (field, value) => {
    setBusy(true)
    try {
      const updated = await patch('/api/auth/google-account', { [field]: value })
      setAcct(updated)
    } catch (e) {
      setNotice({ tone: 'warn', msg: e.message || 'Update failed' })
    }
    setBusy(false)
  }

  if (loading) return null

  return (
    <div className="bg-panel border border-hairline rounded-xl p-5 mb-6">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="text-lg font-bold text-ink">Your Google account</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Connect your own Google account so your Gmail threads into Comms and
            your Calendar drives scheduling — separate from the shared business connection.
          </p>
        </div>
        {acct?.connected && acct.status === 'connected' && <CheckCircle className="w-5 h-5 text-emerald-500 shrink-0" />}
      </div>

      {notice && (
        <div className={`text-xs rounded-lg px-3 py-2 my-2 border ${notice.tone === 'ok'
          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
          : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
          {notice.msg}
        </div>
      )}

      {!acct?.connected ? (
        <div className="mt-3">
          {acct && acct.oauth_available === false && (
            <p className="text-xs text-ink-3 mb-2">Google OAuth isn't configured on the server.</p>
          )}
          {acct && acct.encryption_available === false && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
              The server is missing TOKEN_ENCRYPTION_KEY — ask your admin to set it before connecting.
            </p>
          )}
          <button onClick={connect}
            disabled={busy || acct?.oauth_available === false || acct?.encryption_available === false}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Link2 className="w-4 h-4" /> Connect Google account
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-ink">{acct.email}</span>
            {acct.status === 'expired' ? (
              <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                <AlertTriangle className="w-3 h-3" /> reconnect needed
              </span>
            ) : (
              <span className="text-[11px] px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">connected</span>
            )}
          </div>
          {acct.last_sync_error && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{acct.last_sync_error}</p>
          )}

          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 border border-hairline rounded-lg px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink-2">
                <Mail className="w-4 h-4 text-ink-3" /> Sync Gmail into Comms
              </span>
              <input type="checkbox" checked={!!acct.gmail_sync_enabled} disabled={busy}
                onChange={e => toggle('gmail_sync_enabled', e.target.checked)} className="w-4 h-4" />
            </label>
            <label className="flex items-center justify-between gap-3 border border-hairline rounded-lg px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink-2">
                <Calendar className="w-4 h-4 text-ink-3" /> Use my Calendar for scheduling sync
              </span>
              <input type="checkbox" checked={!!acct.gcal_sync_enabled} disabled={busy}
                onChange={e => toggle('gcal_sync_enabled', e.target.checked)} className="w-4 h-4" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-3">
              {acct.last_sync_at ? `Last sync ${new Date(acct.last_sync_at).toLocaleString()}` : 'Not synced yet'}
            </span>
            <div className="flex items-center gap-2">
              {acct.status === 'expired' && (
                <button onClick={connect} disabled={busy}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
                  <Link2 className="w-3.5 h-3.5" /> Reconnect
                </button>
              )}
              <button onClick={disconnect} disabled={busy}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-panel border border-hairline hover:border-red-300 hover:text-red-700 disabled:opacity-50 text-ink-2 rounded-lg font-medium transition-colors">
                <Unlink className="w-3.5 h-3.5" /> Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
