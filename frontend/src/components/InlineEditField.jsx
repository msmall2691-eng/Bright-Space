import { useState, useEffect } from 'react'

/**
 * Twenty-style click-to-edit field (generalized from ClientProfile's inline
 * editor). Renders a labelled value; click to edit, Enter/blur to save, Escape
 * to cancel. `onSave(value)` may return a promise — a "saving…" hint shows while
 * it resolves. Pass `format` to display a raw value differently (e.g. currency).
 *
 * Empty input saves as null so a field can be cleared.
 */
export default function InlineEditField({
  label, value, type = 'text', placeholder = 'Add', onSave, format, className = '',
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(value ?? '') }, [value])

  const commit = async () => {
    setEditing(false)
    const trimmed = typeof draft === 'string' ? draft.trim() : draft
    if (String(trimmed ?? '') === String(value ?? '')) return
    setSaving(true)
    try { await onSave(trimmed === '' ? null : trimmed) } finally { setSaving(false) }
  }

  const display = value == null || value === '' ? null : (format ? format(value) : value)

  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5 flex items-center gap-1">
        {label}{saving && <span className="normal-case tracking-normal text-ink-3/70">· saving…</span>}
      </div>
      {editing ? (
        <input
          autoFocus type={type} value={draft ?? ''}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false) }
          }}
          className="w-full bg-panel border border-blue-400 rounded px-1.5 py-1 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30"
        />
      ) : (
        <button
          onClick={() => setEditing(true)} title="Click to edit"
          className="text-left text-[13px] text-ink-2 hover:bg-bg-2 rounded px-1 -mx-1 py-0.5 w-full truncate transition-colors"
        >
          {display ?? <span className="text-ink-3 italic">{placeholder}</span>}
        </button>
      )}
    </div>
  )
}
