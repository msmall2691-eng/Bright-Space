import { useState, useEffect } from 'react'
import { get } from "../api"


const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5'
const inp = 'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400 transition-colors'

// ── CustomFieldsForm ──────────────────────────────────────────────────────────
// Renders editable inputs for custom fields in a form panel.
// Props: entityType, values (obj), onChange(key, value)
export function CustomFieldsForm({ entityType, values = {}, onChange }) {
  const [fields, setFields] = useState([])

  useEffect(() => {
    get(`/api/fields?entity_type=${entityType}`).then(setFields).catch(err => console.error("[CustomFields]", err))
  }, [entityType])

  if (fields.length === 0) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-100" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Custom Fields</span>
        <div className="h-px flex-1 bg-gray-100" />
      </div>
      {fields.map(field => (
        <div key={field.key}>
          <label className={lbl}>
            {field.name}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
          <FieldInput
            field={field}
            value={values[field.key] ?? ''}
            onChange={val => onChange(field.key, val)}
          />
        </div>
      ))}
    </div>
  )
}

// ── CustomFieldsDisplay ───────────────────────────────────────────────────────
// Renders a read-only view of custom field values (for profile pages).
// Props: entityType, values (obj)
export function CustomFieldsDisplay({ entityType, values = {} }) {
  const [fields, setFields] = useState([])

  useEffect(() => {
    get(`/api/fields?entity_type=${entityType}`).then(setFields).catch(err => console.error("[CustomFields]", err))
  }, [entityType])

  const populated = fields.filter(f => values[f.key] !== undefined && values[f.key] !== '' && values[f.key] !== null)
  if (populated.length === 0) return null

  return (
    <div className="space-y-3">
      {populated.map(field => (
        <div key={field.key} className="flex items-start gap-3">
          <span className="text-xs text-gray-400 w-32 shrink-0 pt-0.5">{field.name}</span>
          <span className="text-sm text-gray-900 flex-1">
            {field.field_type === 'checkbox'
              ? (values[field.key] ? 'Yes' : 'No')
              : String(values[field.key] || '—')}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── FieldInput ────────────────────────────────────────────────────────────────
function FieldInput({ field, value, onChange }) {
  switch (field.field_type) {
    case 'textarea':
      return (
        <textarea value={value} onChange={e => onChange(e.target.value)}
          rows={3} className={inp + ' resize-none'} />
      )
    case 'number':
      return (
        <input type="number" value={value} onChange={e => onChange(e.target.value)}
          className={inp} />
      )
    case 'date':
      return (
        <input type="date" value={value} onChange={e => onChange(e.target.value)}
          className={inp} />
      )
    case 'select':
      return (
        <select value={value} onChange={e => onChange(e.target.value)} className={inp}>
          <option value="">Select…</option>
          {(field.options || []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-0 cursor-pointer" />
          <span className="text-sm text-gray-600">{field.name}</span>
        </label>
      )
    default: // text
      return (
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          className={inp} />
      )
  }
}
