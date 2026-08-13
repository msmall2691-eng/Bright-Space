/**
 * Me tab — the cleaner's own profile (crew app Phase 1).
 *
 * Self-service contact info: name, phone, emergency contact. Explicit Save
 * (not autosave) — on a phone with gloves, accidental edits are common and a
 * visible "Save" that appears only when something changed is the honest
 * contract. Email and crew ID are shown but not editable (the office owns
 * those from Settings → Users / Crew).
 */
import { useEffect, useState } from 'react'
import { BadgeCheck, IdCard, Mail } from 'lucide-react'
import { get, patch } from '../../api'

const FIELDS = [
  { key: 'full_name', label: 'Your name', type: 'text', autoComplete: 'name' },
  { key: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
  { key: 'emergency_contact_name', label: 'Emergency contact', type: 'text' },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', type: 'tel' },
]

export default function CrewProfile() {
  const [me, setMe] = useState(null)          // server truth
  const [form, setForm] = useState(null)      // edited copy
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    get('/api/crew/me')
      .then(d => { setMe(d); setForm(d) })
      .catch(e => setError(e.detail || e.message || 'Could not load your profile'))
  }, [])

  useEffect(() => {
    if (!savedFlash) return undefined
    const t = setTimeout(() => setSavedFlash(false), 2000)
    return () => clearTimeout(t)
  }, [savedFlash])

  const dirty = me && form && FIELDS.some(f => (form[f.key] || '') !== (me[f.key] || ''))

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const body = {}
      for (const f of FIELDS) {
        if ((form[f.key] || '') !== (me[f.key] || '')) body[f.key] = form[f.key] || ''
      }
      const updated = await patch('/api/crew/me', body)
      setMe(updated); setForm(updated); setSavedFlash(true)
    } catch (e) {
      setError(e.detail || e.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  if (error && !me) {
    return <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
  }
  if (!form) {
    return <div className="h-48 rounded-xl bg-bg-2 animate-pulse" />
  }

  return (
    <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 space-y-4">
      <div>
        <div className="text-sm font-bold text-ink">Your info</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1 bg-bg border border-hairline rounded-full px-2 py-0.5">
            <Mail className="w-3 h-3" /> {form.email}
          </span>
          {form.cleaner_id && (
            <span className="inline-flex items-center gap-1 bg-bg border border-hairline rounded-full px-2 py-0.5">
              <IdCard className="w-3 h-3" /> Crew ID {form.cleaner_id}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {FIELDS.map(f => (
          <label key={f.key} className="block">
            <span className="text-[12px] font-medium text-ink-2">{f.label}</span>
            <input
              type={f.type} autoComplete={f.autoComplete} value={form[f.key] || ''}
              onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-hairline bg-bg px-3 py-2.5 text-[14px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400"
            />
          </label>
        ))}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {(dirty || savedFlash) && (
        <button onClick={save} disabled={saving || !dirty}
          className={`w-full text-[13px] font-semibold py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 ${
            savedFlash && !dirty
              ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/30'
              : 'bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60'}`}>
          {savedFlash && !dirty ? (<><BadgeCheck className="w-4 h-4" /> Saved</>)
            : saving ? 'Saving…' : 'Save changes'}
        </button>
      )}
    </div>
  )
}
