import { useState, useEffect, useRef } from 'react'
import { MapPin } from 'lucide-react'
import { get } from '../api'

// Cached across instances so we only probe /api/geo/config once per page load.
let _geoEnabled = null

/**
 * Street-address input with Google-Places-backed autocomplete (proxied through
 * /api/geo so the key stays server-side). On selecting a suggestion it calls
 * onSelect({ address, city, state, zip_code, lat, lng }) so the form can fill
 * the rest of the address. If geo isn't configured it transparently behaves as
 * a plain text input.
 *
 * Props:
 *  - value, onChange(street): controlled street text
 *  - onSelect(parts): called when a suggestion is chosen
 *  - placeholder, className (input classes)
 */
export default function AddressAutocomplete({ value, onChange, onSelect, placeholder, className }) {
  const [preds, setPreds] = useState([])
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(_geoEnabled !== false)
  const tRef = useRef(null)
  const boxRef = useRef(null)

  useEffect(() => {
    if (_geoEnabled !== null) { setEnabled(_geoEnabled); return }
    get('/api/geo/config')
      .then(r => { _geoEnabled = !!r?.enabled; setEnabled(_geoEnabled) })
      .catch(() => { _geoEnabled = false; setEnabled(false) })
  }, [])

  useEffect(() => {
    const onDoc = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const onType = (v) => {
    onChange?.(v)
    if (!enabled) return
    clearTimeout(tRef.current)
    if (!v || v.trim().length < 3) { setPreds([]); setOpen(false); return }
    tRef.current = setTimeout(async () => {
      try {
        const r = await get(`/api/geo/autocomplete?q=${encodeURIComponent(v)}`)
        if (r?.enabled === false) { _geoEnabled = false; setEnabled(false); return }
        const p = r?.predictions || []
        setPreds(p); setOpen(p.length > 0)
      } catch { /* silent — falls back to plain typing */ }
    }, 250)
  }

  const choose = async (p) => {
    setOpen(false)
    try {
      const d = await get(`/api/geo/place?place_id=${encodeURIComponent(p.place_id)}`)
      if (d && d.enabled !== false) onSelect?.(d)
    } catch { /* ignore */ }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value || ''}
        onChange={e => onType(e.target.value)}
        onFocus={() => preds.length && setOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        className={className}
      />
      {open && enabled && preds.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-panel border border-hairline rounded-lg shadow-xl max-h-56 overflow-y-auto">
          {preds.map(p => (
            <button key={p.place_id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => choose(p)}
              className="w-full flex items-start gap-2 px-3 py-2 text-left text-[12px] text-ink-2 hover:bg-bg-2 transition-colors">
              <MapPin className="w-3.5 h-3.5 mt-0.5 text-ink-3 shrink-0" />
              <span className="truncate">{p.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
