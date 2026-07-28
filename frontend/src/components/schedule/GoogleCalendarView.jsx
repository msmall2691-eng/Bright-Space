import { useState, useEffect } from 'react'
import { Calendar as CalendarIcon, ExternalLink, Settings } from 'lucide-react'
import { get } from '../../api'

/**
 * The main Schedule page's "Google" view — Google Calendar embedded INSIDE
 * BrightBase, so you can use it as the schedule surface directly instead of
 * bouncing to calendar.google.com. Reads /api/settings/gcal-embed — the same
 * embed the client profile uses, which HONORS the calendar URL an operator
 * pasted in Settings (overlay=all deliberately ignores that override and falls
 * back to a hardcoded primary, so it would show the wrong calendar here).
 *
 * `reloadKey` bumps the iframe src so a schedule edit shows through Google's
 * aggressive embed cache.
 */
export default function GoogleCalendarView({ reloadKey = 0 }) {
  const [embed, setEmbed] = useState({ loading: true })

  useEffect(() => {
    get('/api/settings/gcal-embed')
      .then(r => setEmbed({ loading: false, url: r?.embed_url, configured: !!r?.configured }))
      .catch(() => setEmbed({ loading: false, configured: false }))
  }, [])

  if (embed.loading) {
    return (
      <div className="flex-1 grid place-items-center text-ink-3 text-sm">
        <div className="flex items-center gap-2">
          <CalendarIcon className="w-4 h-4 animate-pulse" /> Loading Google Calendar…
        </div>
      </div>
    )
  }

  if (!embed.configured || !embed.url) {
    return (
      <div className="flex-1 grid place-items-center p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 grid place-items-center w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
            <CalendarIcon className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-ink mb-1">Google Calendar not embedded yet</h3>
          <p className="text-sm text-ink-3 mb-4">
            Paste your calendar’s embed link in Settings → Integrations to see it
            right here. Your jobs already sync to Google automatically.
          </p>
          <div className="flex items-center justify-center gap-2">
            <a href="/settings#integrations"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-indigo-600 text-white text-sm font-semibold">
              <Settings className="w-4 h-4" /> Open Settings
            </a>
            <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-bg-2 text-ink-2 text-sm font-semibold">
              <ExternalLink className="w-4 h-4" /> Google Calendar
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-end px-3 py-1.5">
        <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
          <ExternalLink className="w-3.5 h-3.5" /> Open in Google
        </a>
      </div>
      <iframe
        title="Google Calendar"
        src={`${embed.url}&_=${reloadKey}`}
        className="flex-1 w-full border-0"
      />
    </div>
  )
}
