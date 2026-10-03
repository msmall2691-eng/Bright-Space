import { ArrowRight } from 'lucide-react'

/**
 * The calm, airy top of Home: a greeting eyebrow + the single most pressing
 * thing, derived entirely from the board payload OpsBoard already fetched (no
 * new request). One headline, at most two actions (one primary, one ghost),
 * then a hairline divider. It never shouts — the headline carries the weight
 * through size, the dot through meaning.
 *
 * `focus` is computed by OpsBoard from the board payload:
 *   { tone, headline, primary?: {label, to}, ghost?: {label, to} }
 * `tone` only colors the 6px dot (amber = needs attention, emerald = calm).
 */
const DOT = {
  attention: 'bg-amber-500',
  calm: 'bg-emerald-500',
}

function greetingFor(d) {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function FocusBar({ firstName, focus, navigate }) {
  const now = new Date()
  const eyebrow = `${greetingFor(now)}${firstName ? `, ${firstName}` : ''}`
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <section data-testid="home-focus" className="mt-5 bb-board-in">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[focus.tone] || DOT.calm}`} aria-hidden="true" />
        {eyebrow}
        <span className="text-ink-3/70">·</span>
        <span className="normal-case tracking-normal text-ink-3">{dateLabel}</span>
      </p>
      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h1 className="max-w-2xl text-balance text-[22px] font-semibold leading-tight tracking-tight text-ink shell:text-[26px]">
          {focus.headline}
        </h1>
        {(focus.primary || focus.ghost) && (
          <div className="flex items-center gap-2">
            {focus.ghost && (
              <button
                onClick={() => navigate(focus.ghost.to)}
                className="inline-flex h-9 items-center gap-0.5 rounded-md px-1 text-[12.5px] font-semibold text-ink-2 transition-all hover:gap-1 hover:text-ink">
                {focus.ghost.label}<ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            {focus.primary && (
              <button
                onClick={() => navigate(focus.primary.to)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 text-[12.5px] font-semibold text-white shadow-xs transition-colors hover:bg-indigo-700">
                {focus.primary.label}<ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-4 border-b border-hairline" />
    </section>
  )
}
