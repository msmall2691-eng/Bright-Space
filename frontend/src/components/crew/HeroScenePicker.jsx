import { useState } from 'react'
import { Check } from 'lucide-react'
import { HERO_SCENES, skySwatch, currentHeroId, setHero } from '../../utils/heroScene'

/**
 * "Make it yours" — the cleaner picks the gradient scene behind their My Day
 * header. Applies live (HeroBanner listens for 'bb:hero-change') and remembers
 * it on this phone. "My colour" follows their accent pick; the rest are fixed
 * scenes. A row of gradient swatches, the active one ticked.
 */
export default function HeroScenePicker() {
  const [selected, setSelected] = useState(currentHeroId)
  const choose = (id) => { setHero(id); setSelected(id) }

  return (
    <div>
      <p className="mb-2 text-[12.5px] text-ink-2">Pick the look of your Home header.</p>
      <div className="flex flex-wrap gap-2.5">
        {HERO_SCENES.map(s => {
          const active = selected === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => choose(s.id)}
              aria-pressed={active}
              aria-label={s.label}
              title={s.label}
              className={`flex h-9 w-14 items-center justify-center rounded-lg ring-1 ring-black/10 transition-transform active:scale-90 ${
                active ? 'ring-2 ring-offset-2 ring-ink/50 ring-offset-bg' : 'hover:scale-105'
              }`}
              style={skySwatch(s.id)}
            >
              {active && <Check className="h-4 w-4 drop-shadow" style={{ color: '#fff' }} aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Saved on this phone.</p>
    </div>
  )
}
