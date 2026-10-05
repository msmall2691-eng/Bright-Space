import { useEffect, useState } from 'react'
import { Sun, Moon, Cloud, CloudRain, CloudSun } from 'lucide-react'
import { get } from '../../api'

/**
 * My Day's header — a clean, flat greeting with the weather, in the cleaner's
 * own accent colour. No gradient sky, no inline SVG scene: the owner didn't
 * like the painted header and didn't want anything that felt heavy to load, so
 * this is a plain panel that paints instantly and fills the weather in async.
 *
 * Just the greeting, the day line, and the real weather (same GET
 * /api/crew/weather — no new request, brightbase-economy). The daily tips used
 * to sit up here; the owner wanted them "like a sticky note" instead, so they
 * now live in the Tips & notes card (StickyNotes) further down.
 */

function WeatherGlyph({ night, raining, cloudy, className }) {
  const Icon = raining ? CloudRain : cloudy ? Cloud : night ? Moon : CloudSun
  // Clear day gets a full sun; a clear night gets the moon; anything with
  // cloud/rain gets the matching cloud. CloudSun covers the common "mostly
  // clear with a little cloud" day without needing a separate state.
  const Chosen = (!raining && !cloudy && !night) ? Sun : Icon
  return <Chosen className={className} aria-hidden="true" />
}

export default function HeroBanner({ firstName, jobCount }) {
  const [wx, setWx] = useState(null)

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
    </div>
  )
}
