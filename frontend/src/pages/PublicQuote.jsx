import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle, AlertCircle, Clock } from 'lucide-react'

export default function PublicQuote() {
  const { token } = useParams()
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    const fetch = async () => {
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
    fetch()
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="text-center">
          <Clock className="w-12 h-12 text-blue-300 mx-auto mb-4 animate-spin" />
          <p className="text-zinc-600 font-medium">Loading quote...</p>
        </div>
      </div>
    )
  }

  if (error && !quote) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-16 h-16 text-red-300 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-zinc-900 mb-2">Unable to Load Quote</h1>
          <p className="text-zinc-600">{error}</p>
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
          <h1 className="text-2xl font-bold text-zinc-900 mb-2">Thank You!</h1>
          <p className="text-zinc-600 mb-2">Your quote has been accepted.</p>
          <p className="text-sm text-zinc-500">
            We'll reach out shortly to confirm your scheduled date and answer any questions.
          </p>
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
        <div className="bg-white rounded-lg shadow-sm border border-zinc-200 p-6 mb-6">
          {quote.address && (
            <div className="mb-6 pb-6 border-b border-zinc-100">
              <p className="text-xs text-zinc-500 uppercase font-medium mb-1">Service Address</p>
              <p className="text-zinc-900">{quote.address}</p>
            </div>
          )}

          {quote.service_type && (
            <div className="mb-6 pb-6 border-b border-zinc-100">
              <p className="text-xs text-zinc-500 uppercase font-medium mb-1">Service Type</p>
              <p className="text-zinc-900 capitalize">{quote.service_type} cleaning</p>
            </div>
          )}

          {quote.notes && (
            <div className="mb-6 pb-6 border-b border-zinc-100">
              <p className="text-xs text-zinc-500 uppercase font-medium mb-2">Notes</p>
              <p className="text-zinc-700 text-sm">{quote.notes}</p>
            </div>
          )}

          {/* Line items */}
          <div>
            <p className="text-xs text-zinc-500 uppercase font-medium mb-4">Services</p>
            <div className="space-y-3 mb-4">
              {(quote.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <div className="flex-1">
                    <p className="font-medium text-zinc-900">{item.name}</p>
                    {item.description && (
                      <p className="text-xs text-zinc-500 mt-0.5">{item.description}</p>
                    )}
                  </div>
                  <div className="text-right ml-4">
                    {parseFloat(item.qty) !== 1 && (
                      <p className="text-xs text-zinc-500">{item.qty} × ${parseFloat(item.unit_price || 0).toFixed(2)}</p>
                    )}
                    <p className="font-semibold text-zinc-900">
                      ${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="space-y-2 pt-4 border-t border-zinc-100">
              <div className="flex justify-between text-sm text-zinc-600">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              {tax > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Tax ({quote.tax_rate}%)</span>
                  <span>${tax.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold text-zinc-900 pt-2 border-t border-zinc-100">
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
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-zinc-300 text-white font-semibold py-3 rounded-lg transition-colors disabled:cursor-not-allowed"
          >
            {accepting ? 'Accepting...' : 'Accept Quote'}
          </button>
          <p className="text-xs text-zinc-500 text-center">
            By accepting, you're confirming your interest. We'll contact you to schedule the service.
          </p>
        </div>

        {/* Contact */}
        {(quote.company_email || quote.company_phone) && (
          <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
            <p className="text-xs text-zinc-500 mb-2">Questions?</p>
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
