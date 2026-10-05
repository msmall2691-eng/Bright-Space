import { ArrowRight } from 'lucide-react'
import { FOCUS_DOT } from './tokens'

/**
 * The calm, airy top of Home: a greeting eyebrow + the single most pressing
 * thing, derived entirely from the board payload OpsBoard already fetched (no
 * new request). One headline, at most two actions (one primary, one ghost),
 * then a hairline divider. It never shouts — the headline carries the weight
 * through size, the dot through meaning.
 *
 * `focus` is computed by OpsBoard from the board payload:
 *   { tone, headline?, primary?: {label, to}, ghost?: {label, to} }
 * `tone` only colors the 6px dot (amber = needs attention, emerald = calm).
 *
 * The headline is an `<h2>`, not an `<h1>`, even though it is the biggest type
 * on the page. Heading level is document structure, not size: the page's `<h1>`
 * is the identity line in OpsBoard's command row, which is always there. This
 * one is conditional — so if it carried the `<h1>` the outline would appear and
 * disappear depending on how busy the morning was, and a quiet morning would
 * leave the page with no top-level heading at all.
 *
 * `headline` IS OPTIONAL, and that is the quiet morning: when nothing is
 * pressing the hero line is omitted entirely rather than filled with a
 * reassurance ("You're on top of it this morning."), which spent the largest
 * type on the page on the one sentence you can't act on. The greeting eyebrow
 * and the date carry the section alone, and the board underneath — with no
 * rows in it — already says the rest.
 */
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
        <span className={`h-1.5 w-1.5 rounded-full ${FOCUS_DOT[focus.tone] || FOCUS_DOT.calm}`} aria-hidden="true" />
        {eyebrow}
        <span className="text-ink-3/70">·</span>
        <span className="normal-case tracking-normal text-ink-3">{dateLabel}</span>
      </p>
      {(focus.headline || focus.primary || focus.ghost) && (
      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        {focus.headline && (
          <h2 className="max-w-2xl text-balance text-[22px] font-semibold leading-tight tracking-tight text-ink shell:text-[26px]">
            {focus.headline}
          </h2>
        )}
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
      )}
      <div className="mt-4 border-b border-hairline" />
    </section>
  )
}
