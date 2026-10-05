import { useEffect, useState } from 'react'
import { Sun, Moon, Cloud, CloudRain, CloudSun, Lightbulb, ChevronDown, ChevronRight } from 'lucide-react'
import { get } from '../../api'

/**
 * My Day's header — a clean, flat greeting with the weather, in the cleaner's
 * own accent colour. No gradient sky, no inline SVG scene: the owner didn't
 * like the painted header and didn't want anything that felt heavy to load, so
 * this is a plain panel that paints instantly and fills the weather in async.
 *
 * The greeting, the day line, the real weather (same GET /api/crew/weather — no
 * new request, brightbase-economy), and — grouped into the same box, below a
 * hairline — the day's training tip. The owner wanted it "up there, out of the
 * way, concise": one quiet line (today's headline) that taps open to the full
 * tip and flips through the rest of the deck. Not a sticky note; the deck is
 * the office's own tips when it has written any, else the built-in set.
 */

function WeatherGlyph({ night, raining, cloudy, className }) {
  const Icon = raining ? CloudRain : cloudy ? Cloud : night ? Moon : CloudSun
  // Clear day gets a full sun; a clear night gets the moon; anything with
  // cloud/rain gets the matching cloud. CloudSun covers the common "mostly
  // clear with a little cloud" day without needing a separate state.
  const Chosen = (!raining && !cloudy && !night) ? Sun : Icon
  return <Chosen className={className} aria-hidden="true" />
}

export default function HeroBanner({ firstName, jobCount, tips = null }) {
  const [wx, setWx] = useState(null)

  // The tip deck (today's first). Collapsed to one line by default; tap the row
  // to open the detail, "Next tip" to page through the rest without leaving.
  const deck = Array.isArray(tips) ? tips.filter(t => t && t.title) : []
  const [tipIdx, setTipIdx] = useState(0)
  const [tipOpen, setTipOpen] = useState(false)
  const pos = deck.length ? tipIdx % deck.length : 0
  const tip = deck.length ? deck[pos] : null

  useEffect(() => {
    let cancelled = false
    get('/api/crew/weather')
      .then(d => { if (!cancelled && d?.available) setWx(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const h = new Date().getHours()
  const timeOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  const night = h < 7 || h >= 20

  const summary = (wx?.summary || '').toLowerCase()
  const raining = !!wx && wx.precip_chance >= 40
  const cloudy = /cloud|overcast|fog/.test(summary)

  const dayLine = jobCount === 0
    ? 'Nothing on the books today.'
    : `${jobCount} job${jobCount > 1 ? 's' : ''} today.`

  return (
    <div className="rounded-2xl border border-hairline bg-panel px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[20px] font-bold leading-tight text-ink">
            Good {timeOfDay}{firstName ? `, ${firstName}` : ''}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-2">{dayLine}</div>
        </div>

        {wx && (
          <div className="flex shrink-0 items-center gap-2">
            <WeatherGlyph night={night} raining={raining} cloudy={cloudy}
              className="h-7 w-7 text-[color:var(--accent)]" />
            <div className="text-right leading-tight">
              <div className="text-[17px] font-bold tabular-nums text-ink">{wx.temp_f}°</div>
              <div className="text-[11px] text-ink-3 tabular-nums">H {wx.high_f}°</div>
            </div>
          </div>
        )}
      </div>

      {wx?.summary && (
        <div className="mt-1.5 text-[12px] text-ink-3">
          {wx.summary}{raining ? ` · ${wx.precip_chance}% rain` : ''}
        </div>
      )}

      {/* The day's tip — in the same box, below a hairline. One line at rest;
          taps open to the full tip and flips through the deck. */}
      {tip && (
        <div className="mt-3 border-t border-hairline pt-2.5">
          <button type="button" onClick={() => setTipOpen(o => !o)} aria-expanded={tipOpen}
            className="flex w-full items-center gap-2 text-left">
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[9.5px] font-semibold uppercase tracking-wide text-ink-3">
                {pos === 0 ? 'Tip of the day' : 'Pro tip'}
              </span>
              <span className={`block text-[13px] font-semibold leading-snug text-ink ${tipOpen ? '' : 'truncate'}`}>
                {tip.title}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-ink-3 transition-transform ${tipOpen ? 'rotate-180' : ''}`}
              aria-hidden="true" />
          </button>

          {tipOpen && (
            <div className="mt-1.5 pl-[22px]">
              {tip.body && <p className="text-[12.5px] leading-snug text-ink-2">{tip.body}</p>}
              {deck.length > 1 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10.5px] text-ink-3 tabular-nums">{pos + 1} / {deck.length}</span>
                  <button type="button" onClick={() => setTipIdx(i => i + 1)}
                    className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-[color:var(--accent)]">
                    Next tip <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
