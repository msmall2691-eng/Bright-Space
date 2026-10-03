import { useState } from 'react'
import { Check } from 'lucide-react'
import { ACCENTS, rampVars, applyAccent, currentAccentId } from '../../utils/accent'

/**
 * "Make it yours" — a cleaner picks the accent colour their app wears. Applies
 * instantly (and remembers it on this phone, via utils/accent). A row of
 * swatches, the active one ticked; Default restores the app's own colour.
 *
 * The swatch colour is the preset's own 600 stop, drawn with an inline style
 * rather than an accent-mapped class — otherwise every swatch would show the
 * *currently selected* colour instead of the one it offers.
 */
const DEFAULT_SWATCH = '#4f46e5' // app indigo, shown literally so it never shifts

function swatchColor(accent) {
  if (accent.id === 'default' || accent.h == null) return DEFAULT_SWATCH
  return `rgb(${rampVars(accent)['--accent-600']})`
}

export default function AccentPicker() {
  const [selected, setSelected] = useState(currentAccentId())
  const choose = (id) => { applyAccent(id); setSelected(id) }

  return (
    <div>
      <p className="mb-2 text-[12.5px] text-ink-2">Pick the colour your app wears.</p>
      <div className="flex flex-wrap gap-2.5">
        {ACCENTS.map(a => {
          const active = selected === a.id
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => choose(a.id)}
              aria-pressed={active}
              aria-label={a.label}
              title={a.label}
              className={`flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-black/10 transition-transform active:scale-90 ${
                active ? 'ring-2 ring-offset-2 ring-ink/50 ring-offset-bg' : 'hover:scale-110'
              }`}
              style={{ backgroundColor: swatchColor(a) }}
            >
              {active && <Check className="h-4 w-4" style={{ color: '#fff' }} aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Saved on this phone.</p>
    </div>
  )
}
