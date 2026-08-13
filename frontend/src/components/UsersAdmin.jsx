import { useState, useEffect, useCallback } from 'react'
import { Users, Check, X, ShieldCheck, RefreshCw, UserPlus, Mail, Clock, Ban, CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { get, post, patch } from '../api'
import { pushToast } from '../utils/toastBus'

const ROLES = ['admin', 'manager', 'member', 'viewer', 'cleaner']

/**
 * Settings → Users: invite people directly (any role — office or crew), approve
 * or deny self-signups, change roles, set cleaner pay, deactivate.
 *
 * Layout is card-per-person with real labels on every field — the old single
 * cramped row squeezed the person's NAME out of view behind five unlabeled
 * inputs. Identity always gets its own line now.
 */

// One derived visual state per row, so the pill and the buttons can never
// contradict each other (the old screen showed "Active" beside "Re-enable").
function rowState(u) {
  if (!u.active || u.status === 'disabled')
    return { key: 'disabled', label: 'Disabled', Icon: Ban, cls: 'bg-red-50 text-red-700 border-red-200' }
  if (u.status === 'pending')
    return { key: 'pending', label: 'Pending', Icon: Clock, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  if (u.activated === false)
    return { key: 'invited', label: 'Invited', Icon: Mail, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  return { key: 'active', label: 'Active', Icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
}

const inputCls = 'mt-0.5 w-full bg-panel border border-hairline rounded-lg px-2.5 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
const labelCls = 'text-[11px] font-medium text-ink-3'

export default function UsersAdmin() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  // Invite form
  const [invName, setInvName] = useState('')
  const [invEmail, setInvEmail] = useState('')
  const [invRole, setInvRole] = useState('cleaner')
  const [inviting, setInviting] = useState(false)

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
  const saveField = (u, patchObj) => act(u.id, () => patch(`/api/auth/users/${u.id}`, patchObj))
  const resend = (u) => act(u.id, async () => {
    const row = await post(`/api/auth/users/${u.id}/resend-invite`)
    pushToast(`Invite re-sent to ${u.email}`, 'success')
    return row
  })

  const sendInvite = async (e) => {
    e?.preventDefault?.()
    const email = invEmail.trim()
    if (!/.+@.+\..+/.test(email)) { setError('Enter a valid email to send an invite.'); return }
    setInviting(true); setError('')
    try {
      const row = await post('/api/auth/users/invite', {
        full_name: invName.trim(), email, role: invRole,
      })
      setUsers(us => [row, ...us])
      setInvName(''); setInvEmail('')
      pushToast(`Invite sent to ${row.email}`, 'success')
    } catch (err) {
      setError(err.message || 'Could not send that invite.')
    } finally {
      setInviting(false)
    }
  }

  const pending = users.filter(u => u.status === 'pending')
  const rest = users.filter(u => u.status !== 'pending')

  const numOrNull = (v) => {
    const s = String(v ?? '').trim()
    if (s === '') return null
    const n = Number(s)
    return Number.isNaN(n) ? null : n
  }

  const rateField = (u, field, value, label) => (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input
        key={`${u.id}-${field}-${value ?? ''}`}
        type="number" step="0.5" min="0" inputMode="decimal"
        defaultValue={value ?? ''}
        placeholder="Default"
        disabled={busyId === u.id}
        onBlur={e => {
          const v = numOrNull(e.target.value)
          if (v !== (value ?? null)) saveField(u, { [field]: v })
        }}
        className={inputCls}
      />
    </label>
  )

  return (
    <div className="bg-panel border border-hairline rounded-xl p-5 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-ink flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-500" /> Users
        </h2>
        <button onClick={load} className="p-2 rounded-lg text-ink-3 hover:text-ink-2 hover:bg-bg-2" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <p className="text-[13px] text-ink-3 mb-4">
        Invite anyone directly — they get an email link to set their own password.
        Cleaners get a crew login (schedule, time clock, weekly pay); manage their
        pay and crew IDs here or on the <Link to="/crew" className="text-indigo-600 font-medium hover:text-indigo-700">Crew page</Link>.
      </p>

      {error && <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

      {/* Invite someone */}
      <form onSubmit={sendInvite} className="border border-hairline bg-bg-2/40 rounded-xl p-4 mb-5">
        <div className="flex items-center gap-2 text-ink font-semibold text-sm mb-3">
          <UserPlus className="w-4 h-4 text-indigo-500" /> Invite someone
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className={labelCls}>Name</span>
            <input value={invName} onChange={e => setInvName(e.target.value)}
              placeholder="Full name" disabled={inviting} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Email <span className="text-red-500">*</span></span>
            <input type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)}
              placeholder="person@email.com" disabled={inviting} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Role</span>
            <select value={invRole} onChange={e => setInvRole(e.target.value)} disabled={inviting}
              className={`${inputCls} capitalize`}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button type="submit" disabled={inviting}
            className="text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-4 py-2.5 rounded-lg inline-flex items-center gap-1.5 transition-colors">
            <Mail className="w-4 h-4" /> {inviting ? 'Sending…' : 'Send invite'}
          </button>
          <span className="text-[11px] text-ink-3">The link works once and expires after 7 days.</span>
        </div>
      </form>

      {loading && <p className="text-sm text-ink-3 py-4">Loading…</p>}

      {!loading && pending.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
            Waiting for approval ({pending.length})
          </h3>
          <div className="space-y-2">
            {pending.map(u => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 border border-amber-200 bg-amber-50/50 rounded-xl px-4 py-3">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-sm font-semibold text-ink truncate">{u.full_name || u.email}</div>
                  <div className="text-xs text-ink-3 truncate">{u.email} · signed up {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</div>
                </div>
                <button onClick={() => approve(u)} disabled={busyId === u.id}
                  className="flex items-center gap-1 text-sm px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-lg font-medium transition-colors">
                  <Check className="w-4 h-4" /> Approve
                </button>
                <button onClick={() => deny(u)} disabled={busyId === u.id}
                  className="flex items-center gap-1 text-sm px-3.5 py-2 bg-panel border border-hairline hover:border-red-300 hover:text-red-700 disabled:opacity-60 text-ink-2 rounded-lg font-medium transition-colors">
                  <X className="w-4 h-4" /> Deny
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && (
        <div className="space-y-3">
          {rest.map(u => {
            const st = rowState(u)
            return (
              <div key={u.id} className="border border-hairline rounded-xl p-4">
                {/* Identity line — always visible, never crowded out */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink truncate flex items-center gap-1.5">
                      {u.full_name || u.email}
                      {u.role === 'admin' && <ShieldCheck className="w-4 h-4 text-blue-500 shrink-0" title="Admin" />}
                    </div>
                    <div className="text-xs text-ink-3 truncate">
                      {u.email}
                      {u.google_connected ? ' · Google connected' : ''}
                      {u.last_login_at ? ` · last login ${new Date(u.last_login_at).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border shrink-0 ${st.cls}`}>
                    <st.Icon className="w-3 h-3" /> {st.label}
                  </span>
                </div>

                {/* Editable fields — labeled, roomy */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mt-3">
                  <label className="block">
                    <span className={labelCls}>Role</span>
                    <select value={u.role} disabled={busyId === u.id}
                      onChange={e => setRole(u, e.target.value)}
                      className={`${inputCls} capitalize`}>
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  {u.role === 'cleaner' && (
                    <>
                      <label className="block">
                        <span className={labelCls}>Crew ID</span>
                        <input
                          key={`${u.id}-cid-${u.cleaner_id || ''}`}
                          type="text"
                          defaultValue={u.cleaner_id || ''}
                          placeholder="—"
                          title="Links this login to the crew ID on their assigned jobs."
                          disabled={busyId === u.id}
                          onBlur={e => {
                            const v = e.target.value.trim()
                            if (v !== (u.cleaner_id || '')) saveField(u, { cleaner_id: v })
                          }}
                          className={inputCls}
                        />
                      </label>
                      {rateField(u, 'pay_rate_residential', u.pay_rate_residential, 'Residential $/hr')}
                      {rateField(u, 'pay_rate_rental', u.pay_rate_rental, 'Rental $/hr')}
                      {rateField(u, 'pay_rate_deep', u.pay_rate_deep, 'Deep $/hr')}
                    </>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {st.key === 'invited' && (
                    <button onClick={() => resend(u)} disabled={busyId === u.id}
                      className="text-sm font-medium px-3.5 py-2 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg disabled:opacity-60 inline-flex items-center gap-1.5 transition-colors">
                      <Mail className="w-4 h-4" /> Resend invite
                    </button>
                  )}
                  {st.key !== 'disabled' ? (
                    <button onClick={() => setActive(u, false)} disabled={busyId === u.id}
                      className="text-sm px-3.5 py-2 bg-panel border border-hairline hover:border-red-300 hover:text-red-700 disabled:opacity-60 text-ink-3 rounded-lg transition-colors ml-auto">
                      Deactivate
                    </button>
                  ) : (
                    <button onClick={() => setActive(u, true)} disabled={busyId === u.id}
                      className="text-sm px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-lg font-medium transition-colors ml-auto">
                      Re-enable
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {rest.length === 0 && pending.length === 0 && (
            <p className="text-sm text-ink-3 py-4 text-center">
              No users yet — invite your first person above.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
