/**
 * Me tab — "See your work in Google Calendar" card.
 *
 * Hands the cleaner their personal read-only feed URL to SUBSCRIBE to from
 * Google/Apple Calendar. No door codes or notes ever ride in the feed
 * (calendars get shared); details stay in the app. Rotate kills the old
 * URL for a lost phone or an over-shared link.
 */
import { useState } from 'react'
import { CalendarPlus, Check, Copy, RotateCcw } from 'lucide-react'
import { get, post } from '../../api'

export default function CrewCalendarSync() {
  const [url, setUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)

  const fetchLink = async (rotate = false) => {
    setBusy(true); setError(null)
    try {
      const d = rotate
        ? await post('/api/crew/me/calendar-link/rotate')
        : await get('/api/crew/me/calendar-link')
      setUrl(d.url); setCopied(false)
    } catch (e) {
      setError(e.detail || e.message || 'Could not get your link')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setError('Could not copy — long-press the link to copy it manually.')
    }
  }

  return (
    <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 space-y-3">
      <div>
        <div className="text-sm font-bold text-ink flex items-center gap-1.5">
          <CalendarPlus className="w-4 h-4 text-ink-3" /> See your work in your calendar
        </div>
        <p className="text-[11px] text-ink-3 mt-0.5">
          Your jobs, live in Google or Apple Calendar. Times and addresses only —
          door codes stay in this app.
        </p>
      </div>

      {!url ? (
        <button onClick={() => fetchLink(false)} disabled={busy}
          className="w-full text-[13px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg disabled:opacity-60 transition-colors">
          {busy ? 'One sec…' : 'Get my calendar link'}
        </button>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] font-mono text-ink-2 bg-bg border border-hairline rounded-lg px-2.5 py-2 break-all select-all">
            {url}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={copy} disabled={busy}
              className="text-[12.5px] font-semibold bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-1.5">
              {copied ? (<><Check className="w-4 h-4" /> Copied</>) : (<><Copy className="w-4 h-4" /> Copy link</>)}
            </button>
            <button onClick={() => fetchLink(true)} disabled={busy}
              title="Old link stops working"
              className="text-[12.5px] font-semibold bg-panel border border-hairline text-ink-2 py-2 rounded-lg hover:bg-bg-2 disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-1.5">
              <RotateCcw className="w-3.5 h-3.5" /> New link
            </button>
          </div>
          <ol className="text-[11.5px] text-ink-3 leading-relaxed list-decimal pl-4 space-y-0.5">
            <li>Copy the link above.</li>
            <li>Google Calendar → Settings → <span className="font-medium text-ink-2">Add calendar → From URL</span> → paste.</li>
            <li>On iPhone: Settings → Calendar → Accounts → <span className="font-medium text-ink-2">Add Subscribed Calendar</span>.</li>
          </ol>
          <p className="text-[10.5px] text-ink-3">
            Google refreshes subscribed calendars on its own schedule (up to a
            day) — the app is always the up-to-the-minute truth. "New link"
            kills the old URL if it ever leaks.
          </p>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}
    </div>
  )
}
