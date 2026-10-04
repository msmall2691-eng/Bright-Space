import { useEffect, useState } from 'react'
import { Sun, Moon, Cloud, CloudRain, CloudSnow, CloudSun, Lightbulb } from 'lucide-react'
import { get } from '../../api'
import { currentHeroId, heroGradient } from '../../utils/heroScene'

/**
 * My Day's header — a colourful gradient banner the cleaner can style
 * (utils/heroScene), carrying the greeting, today's weather, and a faint
 * pro-tip up top. Replaces the old plain two-line greeting.
 *
 * Weather rides the SAME GET /api/crew/weather the old greeting used — no new
 * request (brightbase-economy). The gradient is pure CSS (no image), and a
 * scrim + drop-shadow keep the white text legible across every scene, pale or
 * dark. Scene changes made on the Me tab recolour this live via 'bb:hero-change'.
 */
function WeatherIcon({ wx, night, className }) {
  const summary = (wx?.summary || '').toLowerCase()
  const Icon =
    wx?.precip_chance >= 40
      ? (/snow|flurr|sleet/.test(summary) ? CloudSnow : CloudRain)
      : /cloud|overcast|fog/.test(summary) ? Cloud
      : /clear|sun/.test(summary) ? (night ? Moon : Sun)
      : night ? Moon : CloudSun
  return <Icon className={className} aria-hidden="true" />
}

export default function HeroBanner({ firstName, jobCount, tip, onTipTap }) {
  const [wx, setWx] = useState(null)
  const [scene, setScene] = useState(currentHeroId)

  useEffect(() => {
    let cancelled = false
    get('/api/crew/weather')
      .then(d => { if (!cancelled && d?.available) setWx(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Live recolour when the cleaner picks a new scene on the Me tab.
  useEffect(() => {
    const onChange = (e) => setScene(e?.detail || currentHeroId())
    window.addEventListener('bb:hero-change', onChange)
    return () => window.removeEventListener('bb:hero-change', onChange)
  }, [])

  const h = new Date().getHours()
  const timeOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
  const night = h >= 20 || h < 6

  const dayLine = jobCount === 0
    ? 'Nothing on the books today.'
    : `${jobCount} job${jobCount > 1 ? 's' : ''} today.`
  const wxLine = wx
    ? `${wx.temp_f}° now · high ${wx.high_f}°${wx.summary ? ` · ${wx.summary}` : ''}${wx.precip_chance >= 40 ? ` · ${wx.precip_chance}% rain` : ''}`
    : null

  return (
    <div className="relative overflow-hidden rounded-2xl" style={{ backgroundImage: heroGradient(scene) }}>
      {/* Scrim: keeps white text legible on a pale scene without dulling a dark one. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-black/5" aria-hidden="true" />
      <div className="relative px-4 pb-4 pt-3 text-white">
        {/* Faint pro-tip, up top — tap for more in Learn. */}
        {tip && (
          <button type="button" onClick={onTipTap}
            className="flex max-w-full items-center gap-1.5 text-left text-[11px] font-medium text-white/75 transition-colors hover:text-white/95">
            <Lightbulb className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{tip}</span>
          </button>
        )}

        <div className="mt-2.5 flex items-start gap-2.5">
          <WeatherIcon wx={wx} night={night} className="mt-0.5 h-7 w-7 shrink-0 drop-shadow" />
          <div className="min-w-0">
            <div className="text-[20px] font-bold leading-tight drop-shadow-sm">
              Good {timeOfDay}{firstName ? `, ${firstName}` : ''}
            </div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-white/90 drop-shadow-sm">
              {dayLine}{wxLine ? ` ${wxLine}.` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
