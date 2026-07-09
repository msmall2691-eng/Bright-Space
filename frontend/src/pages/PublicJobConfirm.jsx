import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle, AlertCircle, Clock, Calendar, MapPin } from 'lucide-react'

function formatTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour = ((parseInt(h, 10) % 12) || 12)
  const ampm = parseInt(h, 10) < 12 ? 'AM' : 'PM'
  return `${hour}:${m} ${ampm}`
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

export default function PublicJobConfirm() {
  const { token } = useParams()
  const [job, setJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [showRequest, setShowRequest] = useState(false)
  const [requestMsg, setRequestMsg] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)

  useEffect(() => {
    const loadJob = async () => {
      try {
        const res = await window.fetch(`/api/jobs/public/${token}`)
        if (!res.ok) {
          if (res.status === 404) setError('Visit not found. The link may be incorrect or expired.')
          else setError('Something went wrong on our end. Please try again in a moment.')
          return
        }
        setJob(await res.json())
      } catch (e) {
        setError('Connection error. Please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    }
    loadJob()
  }, [token])

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      const res = await window.fetch(`/api/jobs/public/${token}/confirm`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || 'Could not confirm. Please try again.')
        return
      }
      setConfirmed(true)
    } catch (e) {
      setError('Connection error. Please try again.')
    } finally {
      setConfirming(false)
    }
  }

  const handleRequestReschedule = async () => {
    setRequesting(true)
    try {
      const res = await window.fetch(`/api/jobs/public/${token}/request-reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: requestMsg.trim() || null }),
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="text-center">
          <Clock className="w-12 h-12 text-blue-300 mx-auto mb-4 animate-spin" />
          <p className="text-ink-2 font-medium">Loading your visit...</p>
        </div>
      </div>
    )
  }

  if (error && !job) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-16 h-16 text-red-300 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-ink mb-2">Unable to Load Visit</h1>
          <p className="text-ink-2">{error}</p>
        </div>
      </div>
    )
  }

  if (!job) return null

  const isConfirmed = confirmed || !!job.customer_confirmed_at
  const isRequested = requested || !!job.reschedule_requested_at
  const brandColor = job.brand_color || '#1f2937'

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-6 sm:px-6 sm:py-10">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="bg-panel rounded-2xl border border-hairline shadow-sm overflow-hidden">
          <div className="px-6 py-5 text-white" style={{ backgroundColor: brandColor }}>
            {job.company_logo_url ? (
              <img src={job.company_logo_url} alt={job.company_name} className="h-8 mb-2 object-contain" />
            ) : (
              <p className="font-semibold text-lg text-white">{job.company_name}</p>
            )}
            <p className="text-sm text-white opacity-90">Upcoming visit</p>
          </div>

          <div className="p-6 space-y-4">
            {job.is_cancelled ? (
              <div className="flex items-center gap-2 rounded-xl bg-bg-2 border border-hairline px-4 py-3">
                <AlertCircle className="w-5 h-5 text-ink-3 shrink-0" />
                <p className="text-sm text-ink-2 font-medium">This visit has been cancelled.</p>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-bold text-ink">{job.title}</h1>
                <div className="space-y-2 text-sm text-ink-2">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-ink-3 shrink-0" />
                    <span>{formatDate(job.scheduled_date)}{job.start_time ? ` · ${formatTime(job.start_time)}${job.end_time ? `–${formatTime(job.end_time)}` : ''}` : ''}</span>
                  </div>
                  {job.address && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-ink-3 shrink-0" />
                      <span>{job.address}</span>
                    </div>
                  )}
                </div>

                {isConfirmed ? (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
                    <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
                    <p className="text-sm text-emerald-800 font-medium">Confirmed — see you then!</p>
                  </div>
                ) : isRequested ? (
                  <div className="flex items-center gap-2 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
                    <CheckCircle className="w-5 h-5 text-blue-600 shrink-0" />
                    <p className="text-sm text-blue-800 font-medium">Reschedule request sent — we'll follow up shortly.</p>
                  </div>
                ) : showRequest ? (
                  <div className="space-y-3 rounded-xl border border-hairline bg-bg p-4">
                    <p className="text-sm font-semibold text-ink">What's going on?</p>
                    <textarea
                      value={requestMsg}
                      onChange={(e) => setRequestMsg(e.target.value)}
                      placeholder="Let us know what you need (optional)"
                      rows={4}
                      className="w-full px-3 py-2 border border-hairline rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowRequest(false)}
                        className="flex-1 px-4 py-3 text-sm font-medium text-ink-2 hover:bg-bg-2 rounded-xl border border-hairline"
                      >
                        Back
                      </button>
                      <button
                        onClick={handleRequestReschedule}
                        disabled={requesting}
                        className="flex-1 px-4 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 text-white rounded-xl disabled:cursor-not-allowed"
                      >
                        {requesting ? 'Sending...' : 'Send request'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 pt-2">
                    <button
                      onClick={handleConfirm}
                      disabled={confirming}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-bg-2 text-white font-semibold py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors disabled:cursor-not-allowed shadow-sm"
                    >
                      {confirming ? 'Confirming...' : "I'll be ready"}
                    </button>
                    <button
                      onClick={() => setShowRequest(true)}
                      className="w-full bg-panel hover:bg-bg border border-hairline text-ink-2 font-medium py-4 sm:py-3 text-base rounded-xl min-h-[52px] transition-colors"
                    >
                      Request a reschedule
                    </button>
                  </div>
                )}
              </>
            )}

            {job.company_phone && (
              <p className="text-xs text-ink-3 text-center pt-2">
                Questions? Call us at <a href={`tel:${job.company_phone.replace(/[^\d+]/g, '')}`} className="underline">{job.company_phone}</a>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
