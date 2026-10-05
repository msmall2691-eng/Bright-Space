import { useEffect, useState } from 'react'
import { Sun, Moon, Cloud, CloudRain, CloudSun, Lightbulb, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { get } from '../../api'

/**
 * My Day's header — a warm, friendly greeting with the weather, in the
 * cleaner's own accent colour. A *soft* accent wash (not the old painted sky
 * scene the owner disliked — just a faint diagonal tint) gives the home a touch
 * of colour while still painting instantly.
 *
 * Holds, grouped into one box: the greeting + day line, a daily motivational
 * quote near the weather, the real weather (same GET /api/crew/weather — no new
 * request, brightbase-economy), and — below a hairline — the day's training
 * tip, kept dainty: one small line at rest that taps open to the full tip and
 * flips through the deck. The deck is the office's own tips when it has written
 * any, else the built-in set.
 */

// Short, original pick-me-ups — friendly and to the point, rotating by the day
// so the home feels a little different each morning. Deliberately generic and
// upbeat (no attributed quotes), and purely client-side: no payload weight.
const QUOTES = [
  'Small steps, spotless results.',
  'You make spaces shine.',
  'Progress, not perfection.',
  'One room at a time.',
  'Bring the sparkle today.',
  'Leave it better than you found it.',
  'The details are the difference.',
  'Your work speaks for itself.',
  'Fresh start, fresh space.',
  'Make today sparkle.',
  "You've got this.",
  'Good vibes, clean spaces.',
  'Every space you touch gets better.',
  'Shine on today.',
]

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

  // The tip deck (today's first). Collapsed to one dainty line by default; tap
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
  const quote = QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length]

  const summary = (wx?.summary || '').toLowerCase()
  const raining = !!wx && wx.precip_chance >= 40
  const cloudy = /cloud|overcast|fog/.test(summary)

  const dayLine = jobCount === 0
    ? 'Nothing on the books today.'
    : `${jobCount} job${jobCount > 1 ? 's' : ''} today.`

  return (
    <div className="relative overflow-hidden rounded-2xl border border-hairline px-4 py-3.5"
      // A faint diagonal accent wash — colour without the heavy painted header.
      style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--panel)) 0%, var(--panel) 60%)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[20px] font-bold leading-tight text-ink">
            Good {timeOfDay}{firstName ? `, ${firstName}` : ''} <span aria-hidden="true">👋</span>
          </div>
          <div className="mt-0.5 text-[13px] text-ink-2">{dayLine}</div>
          {/* A small daily pick-me-up, right by the weather. */}
          <div className="mt-1 flex items-center gap-1 text-[11.5px] italic text-ink-3">
            <Sparkles className="h-3 w-3 shrink-0 text-[color:var(--accent)]" aria-hidden="true" />
            <span className="min-w-0">{quote}</span>
          </div>
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
        <div className="mt-1 text-[11.5px] text-ink-3">
          {wx.summary}{raining ? ` · ${wx.precip_chance}% rain` : ''}
        </div>
      )}

      {/* The day's tip — dainty, one small line below a hairline; taps open to
          the full tip and flips through the deck. */}
      {tip && (
        <div className="mt-2.5 border-t border-hairline/70 pt-2">
          <button type="button" onClick={() => setTipOpen(o => !o)} aria-expanded={tipOpen}
            className="flex w-full items-center gap-1.5 text-left">
            <Lightbulb className="h-3 w-3 shrink-0 text-[color:var(--accent)]" aria-hidden="true" />
            <span className={`min-w-0 flex-1 text-[11.5px] leading-snug ${tipOpen ? '' : 'truncate'}`}>
              <span className="mr-1 text-[8.5px] font-bold uppercase tracking-wide text-ink-3">
                {pos === 0 ? 'Tip' : 'Pro tip'}
              </span>
              <span className="font-medium text-ink-2">{tip.title}</span>
            </span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${tipOpen ? 'rotate-180' : ''}`}
              aria-hidden="true" />
          </button>

          {tipOpen && (
            <div className="mt-1.5 pl-[18px]">
              {tip.body && <p className="text-[11.5px] leading-snug text-ink-2">{tip.body}</p>}
              {deck.length > 1 && (
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-ink-3 tabular-nums">{pos + 1} / {deck.length}</span>
                  <button type="button" onClick={() => setTipIdx(i => i + 1)}
                    className="inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-[color:var(--accent)]">
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
