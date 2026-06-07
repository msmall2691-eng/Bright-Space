import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle, AlertCircle, Clock, MessageSquare, X } from 'lucide-react'

export default function PublicQuote() {
  const { token } = useParams()
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [showRequest, setShowRequest] = useState(false)
  const [requestMsg, setRequestMsg] = useState("")
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState("")
  const [declining, setDeclining] = useState(false)
  const [declined, setDeclined] = useState(false)

  useEffect(() => {
    const loadQuote = async () => {
      try {
        const res = await window.fetch(`/api/quotes/public/${token}`)
        if (!res.ok) {
          if (res.status === 404) setError('Quote not found. The link may have expired.')
          else setError('Unable to load quote. Please try again.')
          return
        }
        const data = await res.json()
        setQuote(data)
      } catch (e) {
        setError('Connection error. Please check your connection.')
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
        body: JSON.stringify({}),
      })

      if (!res.ok) {
        const data = await res.json()
        if (res.status === 409) {
          setError(data.detail || 'This quote has already been accepted.')
        } else {
          setError(data.detail || 'Error accepting quote. Please try again.')
        }
        return
      }

      setAccepted(true)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setAccepting(false)
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

  if (accepted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-green-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <CheckCircle className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-ink mb-2">Thank You!</h1>
          <p className="text-ink-2 mb-2">Your quote has been accepted.</p>
          <p className="text-sm text-ink-3">
            We'll reach out shortly to confirm your scheduled date and answer any questions.
          </p>
        </div>
      </div>
    )
  }

  if (requested) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <MessageSquare className="w-16 h-16 text-blue-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-ink mb-2">Got it.</h1>
          <p className="text-ink-2 mb-2">We received your change request.</p>
          <p className="text-sm text-ink-3">
            We'll review and send you an updated quote shortly.
          </p>
        </div>
      </div>
    )
  }

  if (declined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <X className="w-16 h-16 text-ink-3 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-ink mb-2">Quote declined</h1>
          <p className="text-ink-2 mb-2">Thanks for letting us know.</p>
          <p className="text-sm text-ink-3">If anything changes, just reach out — we'd be glad to help.</p>
        </div>
      </div>
    )
  }

  const subtotal = quote.subtotal || 0
  const tax = quote.tax || 0
  const total = quote.total || 0

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6 sm:p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-bold mb-1">Quote {quote.quote_number || `QT-${quote.id}`}</h1>
          <p className="text-blue-100 text-sm">from {quote.company_name}</p>
          {quote.valid_until && (
            <p className="text-blue-100 text-xs mt-3">Valid until: {quote.valid_until}</p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto p-6 sm:p-8">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Quote details */}
        <div className="bg-panel rounded-lg shadow-sm border border-hairline p-6 mb-6">
          {quote.address && (
            <div className="mb-6 pb-6 border-b border-hairline">
              <p className="text-xs text-ink-3 uppercase font-medium mb-1">Service Address</p>
              <p className="text-ink">{quote.address}</p>
            </div>
          )}

          {quote.service_type && (
            <div className="mb-6 pb-6 border-b border-hairline">
              <p className="text-xs text-ink-3 uppercase font-medium mb-1">Service Type</p>
              <p className="text-ink capitalize">{quote.service_type} cleaning</p>
            </div>
          )}

          {quote.notes && (
            <div className="mb-6 pb-6 border-b border-hairline">
              <p className="text-xs text-ink-3 uppercase font-medium mb-2">Notes</p>
              <p className="text-ink-2 text-sm">{quote.notes}</p>
            </div>
          )}

          {/* Line items */}
          <div>
            <p className="text-xs text-ink-3 uppercase font-medium mb-4">Services</p>
            <div className="space-y-3 mb-4">
              {(quote.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <div className="flex-1">
                    <p className="font-medium text-ink">{item.name}</p>
                    {item.description && (
                      <p className="text-xs text-ink-3 mt-0.5">{item.description}</p>
                    )}
                  </div>
                  <div className="text-right ml-4">
                    {parseFloat(item.qty) !== 1 && (
                      <p className="text-xs text-ink-3">{item.qty} × ${parseFloat(item.unit_price || 0).toFixed(2)}</p>
                    )}
                    <p className="font-semibold text-ink">
                      ${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="space-y-2 pt-4 border-t border-hairline">
              <div className="flex justify-between text-sm text-ink-2">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              {tax > 0 && (
                <div className="flex justify-between text-sm text-ink-2">
                  <span>Tax ({quote.tax_rate}%)</span>
                  <span>${tax.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold text-ink pt-2 border-t border-hairline">
                <span>Total</span>
                <span className="text-emerald-600">${total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="space-y-3">
          <button
            onClick={handleAccept}
            disabled={accepting}
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-bg-2 text-white font-semibold py-4 sm:py-3 text-base rounded-lg min-h-[52px] transition-colors disabled:cursor-not-allowed"
          >
            {accepting ? 'Accepting...' : 'Accept Quote'}
          </button>
          <button
            onClick={() => setShowRequest(true)}
            className="w-full bg-panel hover:bg-bg border border-hairline text-ink-2 font-medium py-4 sm:py-3 text-base rounded-lg min-h-[52px] transition-colors"
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
            By accepting, you're confirming your interest. We'll contact you to schedule the service.
          </p>
        </div>

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

        {/* Contact */}
        {(quote.company_email || quote.company_phone) && (
          <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
            <p className="text-xs text-ink-3 mb-2">Questions?</p>
            <div className="space-y-1">
              {quote.company_email && (
                <p className="text-sm">
                  <a href={`mailto:${quote.company_email}`} className="text-blue-600 hover:underline">
                    {quote.company_email}
                  </a>
                </p>
              )}
              {quote.company_phone && (
                <p className="text-sm">
                  <a href={`tel:${quote.company_phone}`} className="text-blue-600 hover:underline">
                    {quote.company_phone}
                  </a>
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
