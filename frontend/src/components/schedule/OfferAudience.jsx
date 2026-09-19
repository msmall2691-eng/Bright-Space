import { useEffect, useState } from 'react'
import { get } from '../../api'

/**
 * OfferAudience — "who sees this open offer."
 *
 * When a job is open to crew, the office can leave it open to everyone (the
 * default) or limit it to chosen cleaners. This narrows WHO is invited to bid;
 * the sub still asks and the office still decides — an offer, never an
 * assignment (brightbase-marketplace Rule 0). An empty selection means
 * everyone. Design language: quiet dot + word, hairline, no filled pills.
 */
export default function OfferAudience({ audience = [], onSave }) {
  const [open, setOpen] = useState(false)
  const [roster, setRoster] = useState(null)
  const [sel, setSel] = useState(audience)
  const [saving, setSaving] = useState(false)

  const key = (audience || []).join(',')
  useEffect(() => { setSel(audience || []) }, [key])       // resync when the job reloads
  useEffect(() => {
    if (!open || roster) return
    get('/api/crew/roster')
      .then(r => setRoster((r || []).filter(u => u.cleaner_id && u.status !== 'disabled')))
      .catch(() => setRoster([]))
  }, [open, roster])

  const toggle = (cid) => setSel(s => s.includes(cid) ? s.filter(x => x !== cid) : [...s, cid])
  const save = async () => {
    setSaving(true)
    try { await onSave(sel); setOpen(false) }
    finally { setSaving(false) }
  }

  const n = (audience || []).length
  const summary = n === 0 ? 'Everyone' : `${n} cleaner${n === 1 ? '' : 's'}`

  return (
    <div className="mt-2 rounded-lg border border-hairline bg-panel px-3 py-2">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 text-[12px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
          Show to <span className="font-medium text-ink">{summary}</span>
        </span>
        <span className="text-[10px] uppercase tracking-wide opacity-70">{open ? 'Done' : 'Choose'}</span>
      </button>
      {open && (
        <div className="mt-2 border-t border-hairline pt-2">
          {roster === null && <p className="text-[11px] text-ink-3">Loading crew…</p>}
          {roster !== null && (
            <>
              <label className="flex items-center gap-2 py-1 text-[12px] text-ink-2">
                <input type="checkbox" className="bb-check" checked={sel.length === 0}
                  onChange={() => setSel([])} />
                Everyone — open to the whole crew
              </label>
              <div className="max-h-48 overflow-y-auto">
                {roster.map(u => (
                  <label key={u.cleaner_id} className="flex items-center gap-2 py-1 text-[12px] text-ink">
                    <input type="checkbox" className="bb-check" checked={sel.includes(u.cleaner_id)}
                      onChange={() => toggle(u.cleaner_id)} />
                    {u.full_name || u.cleaner_id}
                  </label>
                ))}
                {roster.length === 0 && <p className="text-[11px] text-ink-3">No cleaners yet.</p>}
              </div>
              <p className="text-[10.5px] text-ink-3 mt-1">
                Chosen cleaners are the only ones this offer shows for — they still ask, and you still decide.
              </p>
              <button onClick={save} disabled={saving}
                className="mt-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
