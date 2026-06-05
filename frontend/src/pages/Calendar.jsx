import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, RefreshCw, ExternalLink } from 'lucide-react'
import { get } from '../api'

/**
 * Dedicated, full-width Google Calendar page for admins.
 *
 * Renders the embedded Google Calendar with EVERY calendar overlaid (the work
 * account's primary + each configured GCAL_* calendar) by asking the backend
 * for ?overlay=all. Week / Month / Schedule toggle, a Refresh button to beat
 * Google's embed cache, and an "Open in Google" link.
 *
 * The embed is read-only by Google's design — editing happens in the app's
 * appointment form or in Google itself. If Google isn't connected/embeddable
 * yet, we show a graceful prompt pointing at Settings → Integrations.
 *
 * Note: the overlaid calendars only render for a browser logged into Google
 * with access to all of them — same login/cookie rule as any private embed.
 */
const VIEW_MODES = [
  { value: 'WEEK',  label: 'Week' },
  { value: 'MONTH', label: 'Month' },
  { value: 'AGENDA', label: 'Schedule' },
]

// Swap the embed's mode= param and add a cache-busting nonce on refresh.
function withMode(url, mode, reload) {
  if (!url) return null
  let u = /[&?]mode=/i.test(url)
    ? url.replace(/([&?])mode=[^&]*/i, `$1mode=${mode}`)
    : `${url}${url.includes('?') ? '&' : '?'}mode=${mode}`
  return `${u}&_=${reload}`
}

export default function Calendar() {
  const navigate = useNavigate()
  const [state, setState] = useState({ loading: true })
  const [mode, setMode] = useState('WEEK')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    get('/api/settings/gcal-embed?overlay=all')
      .then(r => setState({ loading: false, url: r?.embed_url, configured: !!r?.configured }))
      .catch(() => setState({ loading: false, configured: false }))
  }, [])

  const src = withMode(state.url, mode, reload)

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-hairline bg-panel/95 backdrop-blur shrink-0 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-5 h-5 text-blue-600 shrink-0" />
          <h1 className="text-base sm:text-lg font-bold text-ink truncate">Calendar</h1>
          <span className="text-[11px] text-ink-3 hidden sm:inline">— all calendars overlaid</span>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center bg-bg-2 rounded-lg p-0.5">
            {VIEW_MODES.map(v => (
              <button
                key={v.value}
                onClick={() => setMode(v.value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  mode === v.value ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setReload(k => k + 1)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-2 bg-bg-2 hover:bg-hairline transition-colors"
            title="Reload the embed (Google caches new events for a few seconds)"
          >
            <RefreshCw className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Refresh</span>
          </button>

          {src && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-blue-600 hover:bg-blue-50 transition-colors"
              title="Open in Google Calendar"
            >
              <ExternalLink className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Open in Google</span>
            </a>
          )}
        </div>
      </div>

      {/* Body */}
      {state.loading ? (
        <div className="flex-1 flex items-center justify-center text-ink-3 text-sm">Loading Google Calendar…</div>
      ) : (!state.configured || !src) ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <CalendarDays className="w-10 h-10 text-ink-3 mx-auto mb-3" />
            <p className="text-sm font-semibold text-ink mb-1">Google Calendar isn't connected yet</p>
            <p className="text-[13px] text-ink-3">
              Connect your work Google account and set the embed in Settings → Integrations,
              then every calendar shows up here, overlaid.
            </p>
            <button
              onClick={() => navigate('/settings?section=integrations')}
              className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              Go to Settings →
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 bg-panel">
          <iframe
            title="Google Calendar — all calendars"
            src={src}
            className="w-full h-full border-0"
            style={{ minHeight: '70vh' }}
          />
        </div>
      )}
    </div>
  )
}
