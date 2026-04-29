import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { get, post } from '../api'
import { ChevronLeft, Lock, DollarSign, CheckCircle, AlertCircle } from 'lucide-react'

export default function PublicPayment() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [invoice, setInvoice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [paying, setPaying] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState(null)
  const [paymentMethod, setPaymentMethod] = useState('card')
  const [formData, setFormData] = useState({
    cardholderName: '',
    email: '',
    phone: '',
  })

  useEffect(() => {
    const load = async () => {
      try {
        const data = await get(`/api/invoices/public/${token}`)
        setInvoice(data)
        if (data.client_email) setFormData(f => ({ ...f, email: data.client_email }))
        if (data.client_phone) setFormData(f => ({ ...f, phone: data.client_phone }))
      } catch (e) {
        setError(e.message || 'Invoice not found')
      }
      setLoading(false)
    }
    load()
  }, [token])

  const handlePay = async (e) => {
    e.preventDefault()
    setPaying(true)
    setPaymentStatus(null)

    try {
      // In production, integrate Stripe here
      // For now, create a payment record
      const result = await post(`/api/invoices/${invoice.id}/pay`, {
        token,
        method: paymentMethod,
        ...formData,
      })
      setPaymentStatus({ success: true, message: result.message })
      setInvoice(prev => ({ ...prev, status: 'paid' }))
    } catch (e) {
      setPaymentStatus({ success: false, message: e.message || 'Payment failed' })
    }
    setPaying(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-zinc-50 to-zinc-100">
        <div className="text-zinc-600">Loading invoice...</div>
      </div>
    )
  }

  if (error || !invoice) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-zinc-50 to-zinc-100">
        <div className="bg-white rounded-xl p-8 max-w-md w-full mx-4 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-zinc-900 mb-2">Invoice Not Found</h2>
          <p className="text-sm text-zinc-600">{error || 'This invoice link is invalid or has expired.'}</p>
        </div>
      </div>
    )
  }

  const isPaid = invoice.status === 'paid'

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="mb-8">
          <button onClick={() => navigate('/')}
            className="flex items-center gap-2 text-indigo-600 hover:text-indigo-700 mb-4 text-sm font-medium">
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <h1 className="text-3xl font-bold text-zinc-900">Payment</h1>
          <p className="text-sm text-zinc-600 mt-1">Invoice {invoice.invoice_number}</p>
        </div>

        {/* Invoice Summary */}
        <div className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
          <div className="flex justify-between items-start mb-6 pb-6 border-b border-zinc-200">
            <div>
              <p className="text-sm text-zinc-600">Invoice Amount</p>
              <p className="text-3xl font-bold text-zinc-900">${(invoice.total || 0).toFixed(2)}</p>
            </div>
            {isPaid && (
              <div className="flex items-center gap-2 text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-lg">
                <CheckCircle className="w-4 h-4" />
                <span className="text-sm font-medium">Paid</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-600">Subtotal</span>
              <span className="text-zinc-900 font-medium">${(invoice.subtotal || 0).toFixed(2)}</span>
            </div>
            {invoice.tax_amount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-zinc-600">Tax</span>
                <span className="text-zinc-900 font-medium">${(invoice.tax_amount || 0).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold pt-3 border-t border-zinc-200">
              <span className="text-zinc-900">Total Due</span>
              <span className="text-indigo-600">${(invoice.total || 0).toFixed(2)}</span>
            </div>
          </div>

          {invoice.notes && (
            <div className="mt-4 pt-4 border-t border-zinc-200">
              <p className="text-xs text-zinc-600 mb-1 font-medium">Notes</p>
              <p className="text-sm text-zinc-700">{invoice.notes}</p>
            </div>
          )}
        </div>

        {!isPaid ? (
          <>
            {/* Payment Methods */}
            <div className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
              <h3 className="text-sm font-semibold text-zinc-900 mb-4">Payment Method</h3>
              <div className="space-y-2 mb-4">
                {[
                  { value: 'card', label: '💳 Credit Card (Stripe)' },
                  { value: 'ach', label: '🏦 Bank Transfer (ACH)' },
                  { value: 'check', label: '📮 Check by Mail' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-50 cursor-pointer">
                    <input
                      type="radio"
                      value={opt.value}
                      checked={paymentMethod === opt.value}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-zinc-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Payment Form */}
            <form onSubmit={handlePay} className="bg-white rounded-xl border border-zinc-200 p-6 mb-6">
              <h3 className="text-sm font-semibold text-zinc-900 mb-4">Payment Details</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1.5">Cardholder Name</label>
                  <input
                    type="text"
                    required
                    value={formData.cardholderName}
                    onChange={(e) => setFormData(f => ({ ...f, cardholderName: e.target.value }))}
                    className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="John Doe"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1.5">Email</label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData(f => ({ ...f, email: e.target.value }))}
                    className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="john@example.com"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1.5">Phone</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData(f => ({ ...f, phone: e.target.value }))}
                    className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="(555) 000-0000"
                  />
                </div>

                {paymentMethod === 'card' && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs text-blue-700 flex items-center gap-2">
                      <Lock className="w-3 h-3" />
                      Card details are securely processed by Stripe
                    </p>
                  </div>
                )}
              </div>

              {paymentStatus && (
                <div className={`mt-4 p-3 rounded-lg text-sm flex items-center gap-2 ${
                  paymentStatus.success
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {paymentStatus.success ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  {paymentStatus.message}
                </div>
              )}

              <button
                type="submit"
                disabled={paying}
                className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-300 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
                <DollarSign className="w-4 h-4" />
                {paying ? 'Processing...' : `Pay $${(invoice.total || 0).toFixed(2)}`}
              </button>
            </form>

            <p className="text-xs text-zinc-600 text-center">
              Questions? Contact us for other payment methods.
            </p>
          </>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
            <CheckCircle className="w-12 h-12 text-emerald-600 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-emerald-900 mb-1">Payment Received</h3>
            <p className="text-sm text-emerald-700">Thank you for your payment!</p>
          </div>
        )}
      </div>
    </div>
  )
}
