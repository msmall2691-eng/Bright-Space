import { useState, useRef, useEffect } from 'react'
import { SlidersHorizontal, ChevronUp, ChevronDown } from 'lucide-react'

/**
 * Column show/hide + reorder dropdown for a list table.
 *
 * The parent owns the state: `value` is the ordered list of *visible* column
 * ids; any registry column not in `value` is hidden. Toggling a hidden column
 * appends it; the up/down arrows reorder within the visible set. `onChange`
 * receives the new ordered visible-id array — drop it straight into the page's
 * saved-view config so column layouts persist per view.
 *
 * Props:
 *   columns – [{ id, label }] full registry of configurable columns
 *   value   – ordered array of visible column ids
 *   onChange – (orderedVisibleIds) => void
 */
export default function ColumnsButton({ columns, value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const labelFor = (id) => columns.find(c => c.id === id)?.label || id
  const visible = value.filter(id => columns.some(c => c.id === id))
  const hidden = columns.filter(c => !value.includes(c.id))

  const toggle = (id) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id])
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= visible.length) return
    const next = [...visible]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Columns</span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 right-0 min-w-[230px] bg-panel border border-hairline rounded-lg shadow-lg py-1">
          {visible.map((id, i) => (
            <div key={id} className="group flex items-center gap-1 px-2 py-1 hover:bg-bg-2 rounded">
              <label className="flex-1 flex items-center gap-2 px-1 py-0.5 text-[12px] text-ink-2 cursor-pointer min-w-0">
                <input type="checkbox" checked onChange={() => toggle(id)}
                  className="w-3.5 h-3.5 rounded border-hairline accent-blue-600 cursor-pointer shrink-0" />
                <span className="truncate">{labelFor(id)}</span>
              </label>
              <button type="button" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}
                className="p-0.5 rounded hover:bg-panel disabled:opacity-30">
                <ChevronUp className="w-3.5 h-3.5 text-ink-3" />
              </button>
              <button type="button" title="Move down" onClick={() => move(i, 1)} disabled={i === visible.length - 1}
                className="p-0.5 rounded hover:bg-panel disabled:opacity-30">
                <ChevronDown className="w-3.5 h-3.5 text-ink-3" />
              </button>
            </div>
          ))}

          {hidden.length > 0 && <div className="my-1 border-t border-hairline" />}

          {hidden.map(c => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-3 hover:bg-bg-2 cursor-pointer">
              <input type="checkbox" checked={false} onChange={() => toggle(c.id)}
                className="w-3.5 h-3.5 rounded border-hairline accent-blue-600 cursor-pointer shrink-0" />
              <span className="truncate">{c.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
