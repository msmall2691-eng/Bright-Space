import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle, AlertCircle, Clock, X, Download, Printer } from 'lucide-react'
import QuoteDocument from '../components/QuoteDocument'

export default function PublicQuote() {
  const { token } = useParams()
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [acceptName, setAcceptName] = useState("")
  const [acceptEmail, setAcceptEmail] = useState("")
  const [showRequest, setShowRequest] = useState(false)
  const [requestMsg, setRequestMsg] = useState("")
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState("")
  const [declining, setDeclining] = useState(false)
  const [declined, setDeclined] = useState(false)
  // Self-scheduling on accept
  const [showSchedule, setShowSchedule] = useState(false)
  const [availability, setAvailability] = useState(null)   // { windows, dates }
  const [loadingAvail, setLoadingAvail] = useState(false)
  const [schedDate, setSchedDate] = useState("")
  const [schedWindow, setSchedWindow] = useState("morning")
  const [scheduling, setScheduling] = useState(false)
  const [scheduled, setScheduled] = useState(null)         // { date_label, window }

  useEffect(() => {
    const loadQuote = async () => {
      try {
        const res = await window.fetch(`/api/quotes/public/${token}`)
        if (!res.ok) {
          // Distinguish a bad/expired link (404) from a server fault (5xx) so a
          // valid link is never wrongly called "broken".
          if (res.status === 404) setError('Quote not found. The link may be incorrect or expired.')
          else setError("Something went wrong on our end. Please try again in a moment.")
          return
        }
        setQuote(await res.json())
      } catch (e) {
        setError('Connection error. Please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    }
    loadQuote()
  }, [token])

  const handleAccept = async () => {
    setAccepting(true)
    try {
      const res = await window.fetch(`/api/quotes/public/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: acceptName.trim() || null,
          email: acceptEmail.trim() || null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || (res.status === 409
          ? 'This quote can no longer be accepted.'
          : 'Error accepting quote. Please try again.'))
        return
      }
      setAccepted(true)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setAccepting(false)
    }
  }

  const openScheduler = async () => {
    setShowSchedule(true)
    if (availability) return
    setLoadingAvail(true)
    try {
      const res = await window.fetch(`/api/quotes/public/${token}/availability`)
      if (!res.ok) { setError('Could not load available dates. Please try again.'); return }
      const data = await res.json()
      setAvailability(data)
      const firstOpen = (data.dates || []).find(d => d.available)
      if (firstOpen) setSchedDate(firstOpen.date)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setLoadingAvail(false)
    }
  }

  const handleSchedule = async () => {
    if (!schedDate) return
    setScheduling(true)
    try {
      const res = await window.fetch(`/api/quotes/public/${token}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: schedDate, window: schedWindow,
          name: acceptName.trim() || null, email: acceptEmail.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail || 'Could not book that time. Please pick another date.')
        return
      }
      setScheduled({ date_label: data.date_label, window: data.window })
      setShowSchedule(false)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setScheduling(false)
    }
  }

  const handleRequestChanges = async () => {
    if (!requestMsg.trim()) return
    setRequesting(true)
    try {
      const res = await window.fetch(`/api/quotes/public/${token}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: requestMsg.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || 'Could not send your request. Please try again.')
        return
      }
      setRequested(true)
      setShowRequest(false)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setRequesting(false)
    }
  }

  const handleDecline = async () => {
    setDeclining(true)
    try {
      const res = await window.fetch(`/api/quotes/public/${token}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason.trim() || null }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || 'Could not decline. Please try again.')
        return
      }
      setDeclined(true)
      setShowDecline(false)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setDeclining(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="text-center">
          <Clock className="w-12 h-12 text-blue-300 mx-auto mb-4 animate-spin" />
          <p className="text-ink-2 font-medium">Loading quote...</p>
        </div>
      </div>
    )
  }

  if (error && !quote) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-16 h-16 text-red-300 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-ink mb-2">Unable to Load Quote</h1>
          <p className="text-ink-2">{error}</p>
        </div>
      </div>
    )
  }

  if (!quote) return null

  // Effective state combines this session's actions with the stored status, so
  // re-opening an already-accepted/declined link shows the right banner — and
  // the document stays visible (and downloadable) in every state.
  const isAccepted = accepted || !!scheduled || ['accepted', 'converted'].includes(quote.status)
  const isDeclined = declined || quote.status === 'declined'
  const isExpired = !isAccepted && !isDeclined && (quote.status === 'expired' || quote.is_expired)
  const isClosed = isAccepted || isDeclined || isExpired
  const todayLong = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const pdfUrl = `/api/quotes/public/${token}/pdf`
  const toolbar = (
    <>
      <a href={`${pdfUrl}?download=1`}
        className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-panel border border-hairline text-ink-2 hover:bg-bg transition-colors">
        <Download className="w-4 h-4" /> Download PDF
      </a>
      <button onClick={() => window.print()}
        className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-panel border border-hairline text-ink-2 hover:bg-bg transition-colors">
        <Printer className="w-4 h-4" /> Print
      </button>
    </>
  )

  const banner = scheduled ? (
    <div className="no-print mb-3 flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
      <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
      <p className="text-sm text-emerald-800 font-medium">
        Booked ✓ for {scheduled.date_label} ({scheduled.window === 'afternoon' ? 'afternoon' : 'morning'}) — we'll confirm the exact time shortly.
      </p>
    </div>
  ) : isAccepted ? (
    <div className="no-print mb-3 flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
      <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
      <p className="text-sm text-emerald-800 font-medium">
        {accepted ? `Accepted ✓ on ${todayLong}` : 'Accepted ✓'} — we'll reach out shortly to confirm your scheduled date.
      </p>
    </div>
  ) : requested ? (
    <div className="no-print mb-3 flex items-center gap-2 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
      <CheckCircle className="w-5 h-5 text-blue-600 shrink-0" />
      <p className="text-sm text-blue-800 font-medium">Change request sent — we'll review and send an updated quote shortly.</p>
    </div>
  ) : isDeclined ? (
    <div className="no-print mb-3 flex items-center gap-2 rounded-xl bg-bg-2 border border-hairline px-4 py-3">
      <X className="w-5 h-5 text-ink-3 shrink-0" />
      <p className="text-sm text-ink-2 font-medium">This quote was declined. If anything changes, just reach out.</p>
    </div>
  ) : isExpired ? (
    <div className="no-print mb-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
      <div className="flex items-center gap-2">
        <Clock className="w-5 h-5 text-amber-600 shrink-0" />
        <p className="text-sm text-amber-800 font-medium">
          This quote expired{quote.valid_until ? ` on ${quote.valid_until}` : ''} — contact us for an updated quote.
        </p>
      </div>
      {(quote.company_email || quote.company_phone) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {quote.company_email && (
            <a href={`mailto:${quote.company_email}`} className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium">Email us</a>
          )}
          {quote.company_phone && (
            <a href={`tel:${quote.company_phone.replace(/[^\d+]/g, '')}`} className="text-xs px-3 py-1.5 rounded-lg bg-panel border border-amber-300 text-amber-800 font-medium">Call us</a>
          )}
        </div>
      )}
    </div>
  ) : null

  const openDates = (availability?.dates || []).filter(d => d.available)

  // Action block (Accept / Schedule / Request / Decline) — only while open.
  const actions = isClosed ? null : (
    <div className="space-y-3 pt-2">
      {/* Light e-signature: who is accepting (optional, but makes it binding). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          value={acceptName}
          onChange={(e) => setAcceptName(e.target.value)}
          placeholder="Your name"
          className="w-full px-3 py-3 border border-hairline rounded-xl text-base focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
        />
        <input
          value={acceptEmail}
          onChange={(e) => setAcceptEmail(e.target.value)}
          placeholder="Your email (for the receipt)"
          type="email"
          className="w-full px-3 py-3 border border-hairline rounded-xl text-base focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
        />
      </div>

      {showSchedule ? (
        <div className="space-y-3 rounded-xl border border-hairline bg-bg p-4">
          <p className="text-sm font-semibold text-ink">Pick a date &amp; arrival window</p>
          {loadingAvail ? (
            <p className="text-sm text-ink-3">Loading available dates…</p>
          ) : openDates.length === 0 ? (
            <p className="text-sm text-ink-3">No open dates right now — accept and we'll reach out to schedule.</p>
          ) : (
            <>
              <select
                value={schedDate}
                onChange={(e) => setSchedDate(e.target.value)}
                className="w-full px-3 py-3 border border-hairline rounded-xl text-base bg-panel focus:ring-2 focus:ring-emerald-500"
              >
                {openDates.map(d => (
                  <option key={d.date} value={d.date}>
                    {new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                {(availability?.windows || []).map(w => (
                  <button
                    key={w.key}
                    onClick={() => setSchedWindow(w.key)}
                    className={`py-3 rounded-xl text-sm font-medium border transition-colors ${schedWindow === w.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-panel text-ink-2 border-hairline hover:bg-bg-2'}`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <button
                onClick={handleSchedule}
                disabled={scheduling || !schedDate}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-bg-2 text-white font-semibold py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors disabled:cursor-not-allowed shadow-sm"
              >
                {scheduling ? 'Booking…' : 'Accept & book this time'}
              </button>
            </>
          )}
          <button onClick={() => setShowSchedule(false)} className="w-full text-ink-3 hover:text-ink-2 font-medium py-1 text-sm">
            Back
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={openScheduler}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors shadow-sm"
          >
            Accept &amp; schedule
          </button>
          <button
            onClick={handleAccept}
            disabled={accepting}
            className="w-full bg-panel hover:bg-bg border border-hairline text-ink-2 font-medium py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors disabled:cursor-not-allowed"
          >
            {accepting ? 'Accepting...' : "Accept — we'll reach out to schedule"}
          </button>
          <button
            onClick={() => setShowRequest(true)}
            className="w-full bg-panel hover:bg-bg border border-hairline text-ink-2 font-medium py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors"
          >
            Request changes
          </button>
          <button
            onClick={() => setShowDecline(true)}
            className="w-full text-ink-3 hover:text-red-600 font-medium py-2 text-sm transition-colors"
          >
            Decline quote
          </button>
          <p className="text-xs text-ink-3 text-center">
            By accepting, you agree to the quote's terms &amp; conditions.
          </p>
        </>
      )}
    </div>
  )

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-2xl mx-auto px-4 py-6 sm:px-6 sm:py-10">
        {error && (
          <div className="no-print bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* THE quote document — always visible, in every state, with PDF/print */}
        <QuoteDocument quote={quote} actions={actions} toolbar={toolbar} banner={banner} />

        {showRequest && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
            <div className="w-full sm:max-w-md bg-panel rounded-t-2xl sm:rounded-lg shadow-xl flex flex-col max-h-[95vh]">
              <div className="p-5 border-b border-hairline">
                <h2 className="text-lg font-bold text-ink">What would you like changed?</h2>
                <p className="text-xs text-ink-3 mt-1">Tell us what to adjust and we'll send you a new quote.</p>
              </div>
              <div className="p-5 overflow-y-auto flex-1">
                <textarea
                  value={requestMsg}
                  onChange={(e) => setRequestMsg(e.target.value)}
                  placeholder="e.g. Can we add a deep clean of the kitchen? Or remove the basement?"
                  rows={6}
                  className="w-full px-3 py-2 border border-hairline rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                  autoFocus
                />
              </div>
              <div className="p-4 border-t border-hairline bg-bg flex justify-end gap-2">
                <button onClick={() => setShowRequest(false)} className="px-4 py-2 text-sm font-medium text-ink-2 hover:bg-bg-2 rounded-lg">Cancel</button>
                <button
                  onClick={handleRequestChanges}
                  disabled={requesting || !requestMsg.trim()}
                  className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 text-white rounded-lg disabled:cursor-not-allowed"
                >
                  {requesting ? 'Sending...' : 'Send request'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showDecline && (
          <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
            <div className="w-full sm:max-w-md bg-panel rounded-t-2xl sm:rounded-lg shadow-xl flex flex-col max-h-[95vh]">
              <div className="p-5 border-b border-hairline">
                <h2 className="text-lg font-bold text-ink">Decline this quote?</h2>
                <p className="text-xs text-ink-3 mt-1">Optionally tell us why — it helps us improve.</p>
              </div>
              <div className="p-5 overflow-y-auto flex-1">
                <textarea
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Reason (optional)"
                  rows={4}
                  className="w-full px-3 py-2 border border-hairline rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
              </div>
              <div className="p-4 border-t border-hairline bg-bg flex justify-end gap-2">
                <button onClick={() => setShowDecline(false)} className="px-4 py-2 text-sm font-medium text-ink-2 hover:bg-bg-2 rounded-lg">Cancel</button>
                <button
                  onClick={handleDecline}
                  disabled={declining}
                  className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:bg-bg-2 text-white rounded-lg disabled:cursor-not-allowed"
                >
                  {declining ? 'Declining...' : 'Decline quote'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
