import { useState, useRef, useEffect } from 'react'

/**
 * Twenty-style click-to-edit chip. Renders the current value as a pill; clicking
 * opens a dropdown to pick a new value and fires onSelect (the parent persists +
 * updates state). Stops row-click propagation so it works inside clickable rows.
 *
 * options: [{ value, label, chipClass?, dot? }]
 */
export default function InlineSelect({ value, options, onSelect, disabled = false }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = options.find(o => o.value === value)

  return (
    <span ref={ref} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        title={disabled ? undefined : 'Click to change'}
        className={`inline-flex h-5 min-h-0 items-center gap-1.5 whitespace-nowrap rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium capitalize leading-none text-ink-2 transition
          ${disabled ? '' : 'cursor-pointer hover:bg-bg-2'}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${current?.dot || 'bg-ink-3'}`} aria-hidden />
        {current?.label || value || '—'}
      </button>
      {open && !disabled && (
        <div className="absolute z-20 mt-1 left-0 min-w-[130px] bg-panel border border-hairline rounded-lg shadow-lg py-1">
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => { setOpen(false); if (o.value !== value) onSelect(o.value) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-2 flex items-center gap-2
                ${o.value === value ? 'font-semibold text-ink' : 'text-ink-2'}`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${o.dot || 'bg-ink-3'}`} />
              <span className="capitalize">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
