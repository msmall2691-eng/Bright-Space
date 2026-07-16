import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { get, put } from '../../api'
import { inp, lbl } from './constants'

/** Editable list of the services the company offers + the customer-facing
 *  "what's included" scope for each. Backed by GET/PUT /api/settings/service-scopes
 *  (one JSON app-setting). This is what drives the quote composer's Service Type
 *  selector and the scope that pre-fills a new quote — so editing here follows
 *  through to every quote the customer receives. Defaults match the
 *  scope-of-services shown on maineclean.co.
 *
 *  Self-contained (own load/save) so it can drop into the General tab in place
 *  of the old three fixed textareas, which couldn't add a new service. */

// slug a label into a url-safe key for a brand-new service the operator adds.
const slugify = (s) => (s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 40)

export default function ServiceScopesEditor({ toast }) {
  const [services, setServices] = useState(null) // null = loading
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    get('/api/settings/service-scopes')
      .then(d => setServices(Array.isArray(d?.services) ? d.services : []))
      .catch(() => setServices([]))
  }, [])

  const updateAt = (i, patch) =>
    setServices(list => list.map((s, idx) => idx === i ? { ...s, ...patch } : s))

  const removeAt = (i) => setServices(list => list.filter((_, idx) => idx !== i))

  const addService = () =>
    setServices(list => [...list, { key: '', label: '', scope: '', _new: true }])

  const save = async () => {
    // Fill in a key from the label for any new row the operator didn't key,
    // and validate client-side for a friendly message before the PUT.
    const cleaned = services.map(s => ({
      key: (s.key || '').trim() || slugify(s.label),
      label: (s.label || '').trim(),
      scope: (s.scope || '').trim(),
    }))
    if (cleaned.some(s => !s.label)) {
      toast('Every service needs a name', 'error'); return
    }
    if (cleaned.some(s => !s.key)) {
      toast('Every service needs a name we can turn into a key', 'error'); return
    }
    const keys = cleaned.map(s => s.key)
    if (new Set(keys).size !== keys.length) {
      toast('Two services have the same key — rename one', 'error'); return
    }
    setSaving(true)
    try {
      const d = await put('/api/settings/service-scopes', { services: cleaned })
      setServices(Array.isArray(d?.services) ? d.services : cleaned)
      toast('Service scopes saved')
    } catch (e) {
      toast(e?.message || 'Failed to save service scopes', 'error')
    }
    setSaving(false)
  }

  return (
    <div>
      <h2 className="text-lg font-bold text-ink mb-4">Service Scopes</h2>
      <div className="bg-panel rounded-xl border border-hairline p-6 space-y-4">
        <p className="text-[11px] text-ink-3 -mt-1">
          The services you offer and the customer-facing "what's included" scope for each.
          This drives the Service Type options and the scope that pre-fills when you create a
          quote — so what you write here is what the customer sees. Defaults match maineclean.co.
        </p>

        {services === null ? (
          <div className="flex items-center gap-2 text-ink-3 text-sm py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
          </div>
        ) : (
          <>
            {services.map((s, i) => (
              <div key={i} className="rounded-lg border border-hairline p-4 space-y-2 bg-bg">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <label className={lbl}>Service name</label>
                    <input value={s.label}
                      onChange={e => updateAt(i, { label: e.target.value })}
                      placeholder="e.g. Deep Clean"
                      className={inp} />
                  </div>
                  <button onClick={() => removeAt(i)} title="Remove service"
                    className="mt-6 p-2 rounded-lg text-ink-3 hover:text-red-500 hover:bg-red-50 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div>
                  <label className={lbl}>
                    Scope <span className="text-ink-3 font-normal">— shown on the quote email, PDF, and public page</span>
                  </label>
                  <textarea rows={6} value={s.scope}
                    onChange={e => updateAt(i, { scope: e.target.value })}
                    placeholder="What's included for this service…"
                    className={inp + ' resize-y font-mono text-[12px] leading-relaxed'} />
                </div>
                <p className="text-[11px] text-ink-3">
                  Key: <code className="text-ink-2">{(s.key || slugify(s.label)) || '—'}</code>
                  {s.key ? '' : ' (auto-generated from the name)'}
                </p>
              </div>
            ))}

            <button onClick={addService}
              className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium">
              <Plus className="w-4 h-4" /> Add a service
            </button>

            <div className="pt-2">
              <button onClick={save} disabled={saving}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Save service scopes
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
