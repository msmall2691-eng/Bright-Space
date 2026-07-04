/** Read-only preview of a custom field. Renders the input the user will
 *  actually see, disabled — so the field panel can show what they're
 *  about to save. Options is the raw newline-separated string from the
 *  form (parsed to lines here). */
export default function FieldPreview({ type, options }) {
  const cls = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink-3 pointer-events-none'
  switch (type) {
    case 'textarea':
      return <textarea rows={2} placeholder="Long text…" className={cls + ' resize-none'} readOnly />
    case 'number':
      return <input type="number" placeholder="0" className={cls} readOnly />
    case 'date':
      return <input type="date" className={cls} readOnly />
    case 'select': {
      const opts = options.split('\n').map(s => s.trim()).filter(Boolean)
      return (
        <select className={cls} disabled>
          <option value="">Select…</option>
          {opts.map(o => <option key={o}>{o}</option>)}
        </select>
      )
    }
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 pointer-events-none">
          <input type="checkbox" className="w-4 h-4 rounded border-hairline" readOnly />
          <span className="text-sm text-ink-3">Yes / No</span>
        </label>
      )
    default:
      return <input type="text" placeholder="Text value…" className={cls} readOnly />
  }
}
