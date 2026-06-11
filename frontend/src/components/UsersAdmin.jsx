import { useState, useEffect, useCallback } from 'react'
import { Users, Check, X, ShieldCheck, RefreshCw } from 'lucide-react'
import { get, post, patch } from '../api'

const ROLES = ['admin', 'manager', 'member', 'viewer', 'cleaner']

const STATUS_STYLES = {
  active:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending:  'bg-amber-50 text-amber-700 border-amber-200',
  disabled: 'bg-red-50 text-red-700 border-red-200',
}

/**
 * Settings → Users: approve/deny pending signups, change roles, deactivate.
 * Backed by the admin-only /api/auth/users endpoints; the backend refuses any
 * change that would leave the workspace without an active admin.
 */
export default function UsersAdmin() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    get('/api/auth/users')
      .then(d => setUsers(Array.isArray(d) ? d : []))
      .catch(e => setError(e.message || 'Could not load users'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const act = async (id, fn) => {
    setBusyId(id); setError('')
    try {
      const updated = await fn()
      setUsers(us => us.map(u => (u.id === updated.id ? updated : u)))
    } catch (e) {
      setError(e.message || 'Action failed')
    }
    setBusyId(null)
  }

  const approve = (u) => act(u.id, () => post(`/api/auth/users/${u.id}/approve`))
  const deny = (u) => act(u.id, () => post(`/api/auth/users/${u.id}/deny`))
  const setRole = (u, role) => act(u.id, () => patch(`/api/auth/users/${u.id}`, { role }))
  const setActive = (u, active) => act(u.id, () => patch(`/api/auth/users/${u.id}`, { active }))

  const pending = users.filter(u => u.status === 'pending')
  const rest = users.filter(u => u.status !== 'pending')

  return (
    <div className="bg-panel border border-hairline rounded-xl p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-ink flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-500" /> Users
        </h2>
        <button onClick={load} className="p-1.5 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-ink-3 mb-4">
        New sign-ups wait here until you approve them. Approved users start as
        “member” (can work jobs, quotes, and comms — no settings or user management).
      </p>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
      {loading && <p className="text-sm text-ink-3 py-4">Loading…</p>}

      {!loading && pending.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
            Waiting for approval ({pending.length})
          </h3>
          <div className="space-y-2">
            {pending.map(u => (
              <div key={u.id} className="flex items-center gap-3 border border-amber-200 bg-amber-50/50 rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{u.full_name || u.email}</div>
                  <div className="text-xs text-ink-3 truncate">{u.email} · signed up {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</div>
                </div>
                <button onClick={() => approve(u)} disabled={busyId === u.id}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-lg font-medium transition-colors">
                  <Check className="w-3.5 h-3.5" /> Approve
                </button>
                <button onClick={() => deny(u)} disabled={busyId === u.id}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 bg-panel border border-hairline hover:border-red-300 hover:text-red-700 disabled:opacity-60 text-ink-2 rounded-lg font-medium transition-colors">
                  <X className="w-3.5 h-3.5" /> Deny
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && (
        <div className="space-y-1.5">
          {rest.map(u => (
            <div key={u.id} className="flex items-center gap-3 border border-hairline rounded-lg px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink truncate flex items-center gap-1.5">
                  {u.full_name || u.email}
                  {u.role === 'admin' && <ShieldCheck className="w-3.5 h-3.5 text-blue-500" title="Admin" />}
                </div>
                <div className="text-xs text-ink-3 truncate">
                  {u.email}
                  {u.google_connected ? ' · Google connected' : ''}
                  {u.last_login_at ? ` · last login ${new Date(u.last_login_at).toLocaleDateString()}` : ''}
                </div>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border capitalize shrink-0 ${STATUS_STYLES[u.status] || STATUS_STYLES.active}`}>
                {u.status}
              </span>
              <select value={u.role} disabled={busyId === u.id}
                onChange={e => setRole(u, e.target.value)}
                className="bg-panel border border-hairline rounded-lg px-2 py-1.5 text-xs focus:outline-none shrink-0 capitalize">
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {u.active && u.status !== 'disabled' ? (
                <button onClick={() => setActive(u, false)} disabled={busyId === u.id}
                  className="text-xs px-2.5 py-1.5 bg-panel border border-hairline hover:border-red-300 hover:text-red-700 disabled:opacity-60 text-ink-3 rounded-lg transition-colors shrink-0">
                  Deactivate
                </button>
              ) : (
                <button onClick={() => setActive(u, true)} disabled={busyId === u.id}
                  className="text-xs px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-lg transition-colors shrink-0">
                  Re-enable
                </button>
              )}
            </div>
          ))}
          {rest.length === 0 && pending.length === 0 && (
            <p className="text-sm text-ink-3 py-4 text-center">No users yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
