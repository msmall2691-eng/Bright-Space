import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { get } from '../../api'
import { currentHeroId, resolveScene, skyStyle, timeScene } from '../../utils/heroScene'

/**
 * My Day's header — a soft SKY behind the greeting and the weather, drawn with
 * a CSS gradient + a little inline SVG (sun / moon / clouds / rain / stars). The
 * palette is the cleaner's chosen scene (default: the time of day); the sun or
 * moon follows the REAL clock and the clouds/rain follow the REAL weather, so
 * the header actually reflects their morning.
 *
 * Weather rides the same GET /api/crew/weather the greeting always used — no new
 * request (brightbase-economy). Text colour adapts to the sky (dark ink on a
 * light sky, white on a dark one) so it's always legible, and the tip wraps
 * instead of truncating. Scene picks on the Me tab repaint this live.
 */

/* ── the little sky scene ──────────────────────────────────────────────────── */
function Cloud({ x, y, s = 1, fill = '#ffffff', opacity = 0.85 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill={fill} opacity={opacity}>
      <ellipse cx="0" cy="8" rx="26" ry="12" />
      <ellipse cx="18" cy="2" rx="18" ry="14" />
      <ellipse cx="-18" cy="4" rx="16" ry="11" />
      <rect x="-26" y="6" width="44" height="12" rx="6" />
    </g>
  )
}

function SkyArt({ night, raining, cloudy }) {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 400 150"
      preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="bb-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff7da" />
          <stop offset="55%" stopColor="#ffdf7e" />
          <stop offset="100%" stopColor="#ffdf7e" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="bb-moon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="60%" stopColor="#e7ecf6" />
          <stop offset="100%" stopColor="#e7ecf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Stars, only at night and only when the sky's clear enough to see them */}
      {night && !cloudy && !raining && [[40, 30], [86, 54], [150, 24], [300, 66], [356, 36], [264, 28]].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i % 2 ? 1.6 : 1.1} fill="#ffffff" opacity={0.85} />
      ))}

      {/* Sun or moon — follows the real clock; hidden when it's pouring */}
      {!raining && (
        night
          ? (<><circle cx="322" cy="46" r="34" fill="url(#bb-moon)" /><circle cx="322" cy="46" r="15" fill="#f3f6fc" /></>)
          : (<><circle cx="322" cy="46" r="40" fill="url(#bb-sun)" /><circle cx="322" cy="46" r="18" fill="#fff2bf" /></>)
      )}

      {/* Clouds — a couple always, more when it's grey; a rain cloud when wet */}
      <Cloud x={70} y={34} s={0.8} opacity={night ? 0.5 : 0.8} />
      {(cloudy || raining) && <Cloud x={300} y={40} s={1} opacity={night ? 0.6 : 0.92} />}
      {cloudy && !raining && <Cloud x={180} y={22} s={0.7} opacity={night ? 0.45 : 0.7} />}

      {/* Rain under the right-hand cloud */}
      {raining && [296, 312, 328, 344].map((x, i) => (
        <line key={i} x1={x} y1={58} x2={x - 6} y2={78} stroke={night ? '#cdd6ea' : '#8fa6c6'}
          strokeWidth="2" strokeLinecap="round" opacity="0.7" />
      ))}
    </svg>
  )
}

export default function HeroBanner({ firstName, jobCount, tips = [], onTipTap }) {
  const [wx, setWx] = useState(null)
  const [heroId, setHeroId] = useState(currentHeroId)

  useEffect(() => {
    let cancelled = false
    get('/api/crew/weather')
      .then(d => { if (!cancelled && d?.available) setWx(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onChange = (e) => setHeroId(e?.detail || currentHeroId())
    window.addEventListener('bb:hero-change', onChange)
    return () => window.removeEventListener('bb:hero-change', onChange)
  }, [])

  const scene = resolveScene(heroId)
  const night = timeScene() === 'night'
  const h = new Date().getHours()
  const timeOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'

  const summary = (wx?.summary || '').toLowerCase()
  const raining = !!wx && wx.precip_chance >= 40
  const cloudy = /cloud|overcast|fog/.test(summary)

  const dayLine = jobCount === 0
    ? 'Nothing on the books today.'
    : `${jobCount} job${jobCount > 1 ? 's' : ''} today.`
  const wxLine = wx
    ? `${wx.temp_f}° now · high ${wx.high_f}°${wx.summary ? ` · ${wx.summary}` : ''}${raining ? ` · ${wx.precip_chance}% rain` : ''}`
    : null

  const head = scene.dark ? 'text-white' : 'text-slate-900'
  const sub = scene.dark ? 'text-white/90' : 'text-slate-700'
  const tipTone = scene.dark ? 'text-white/80 hover:text-white' : 'text-slate-600 hover:text-slate-900'

  return (
    <div className="relative min-h-[132px] overflow-hidden rounded-2xl" style={skyStyle(scene)}>
      <SkyArt night={night} raining={raining} cloudy={cloudy} />
      {/* Seat the text on a dark sky; harmless on a light one (very faint). */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" aria-hidden="true" />
      <div className="relative px-4 pb-4 pt-3">
        {tips.length > 0 && (
          <div className="space-y-0.5">
            {tips.map((t, i) => (
              <button key={i} type="button" onClick={onTipTap}
                className={`flex w-[82%] items-start gap-1.5 text-left text-[11px] font-medium leading-snug transition-colors ${tipTone}`}>
                <Lightbulb className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="line-clamp-2">{t}</span>
              </button>
            ))}
          </div>
        )}
        <div className={`mt-2.5 text-[21px] font-bold leading-tight drop-shadow-sm ${head}`}>
          Good {timeOfDay}{firstName ? `, ${firstName}` : ''}
        </div>
        <div className={`mt-0.5 w-[80%] text-[12.5px] leading-snug drop-shadow-sm ${sub}`}>
          {dayLine}{wxLine ? ` ${wxLine}.` : ''}
        </div>
      </div>
    </div>
  )
}
