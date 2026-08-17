/**
 * Shared constants + small CSS-class strings for the Settings page and its
 * extracted sub-tabs. Everything here is closure-free — pure values only.
 */

export const ENTITY_TABS = [
  { key: 'client',   label: 'Clients',    desc: 'Fields shown on every client record' },
  { key: 'property', label: 'Properties', desc: 'Fields shown on every property record' },
  { key: 'job',      label: 'Jobs',       desc: 'Fields shown on every job / appointment' },
  { key: 'invoice',  label: 'Invoices',   desc: 'Fields shown on every invoice' },
]

export const FIELD_TYPES = [
  { value: 'text',     label: 'Text' },
  { value: 'number',   label: 'Number' },
  { value: 'date',     label: 'Date' },
  { value: 'select',   label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'textarea', label: 'Long text' },
]

// Field-type indicator = dot + word (design law: no tinted pill backgrounds).
// Keyed by field type value; each entry is just the dot color class.
export const TYPE_BADGE = {
  text:     'bg-ink-3',
  number:   'bg-blue-500',
  date:     'bg-violet-500',
  select:   'bg-amber-500',
  checkbox: 'bg-emerald-500',
  textarea: 'bg-ink-3',
}

export const EMPTY_FORM = { name: '', field_type: 'text', options: '', required: false, sort_order: 0 }

// Field-panel label + input classNames — used by the custom-fields tab.
export const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1.5'
export const inp = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 transition-colors'
