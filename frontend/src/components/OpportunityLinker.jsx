import { useState, useEffect } from 'react'
import { get, patch } from '../api'
import { X, Link2, Loader } from 'lucide-react'
import { toast } from '../utils/toastBus'

// Stage hue as a small dot over a quiet chip (no tinted pill bubbles).
const STAGE_DOTS = {
  new:       'bg-amber-500',
  qualified: 'bg-blue-500',
  quoted:    'bg-purple-500',
  won:       'bg-emerald-500',
  lost:      'bg-red-500',
}

export default function OpportunityLinker({ clientId, itemType, itemId, itemName, currentOpportunityId, onLinked }) {
  const [opportunities, setOpportunities] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedOppId, setSelectedOppId] = useState(currentOpportunityId || null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    if (showModal) {
      loadOpportunities()
    }
  }, [showModal])

  const loadOpportunities = async () => {
    setLoading(true)
    try {
      const opps = await get(`/api/opportunities?client_id=${clientId}`)
      setOpportunities(opps || [])
    } catch (error) {
      console.error('Error loading opportunities:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleLink = async () => {
    if (!selectedOppId) return

    setSaving(true)
    try {
      const endpoint = itemType === 'job' ? `/api/jobs/${itemId}`
        : itemType === 'quote' ? `/api/quotes/${itemId}`
        : `/api/invoices/${itemId}`

      await patch(endpoint, { opportunity_id: selectedOppId })

      // Notify parent
      if (onLinked) {
        onLinked(selectedOppId)
      }

      setShowModal(false)
    } catch (error) {
      console.error('Error linking to opportunity:', error)
      toast.error('Failed to link to opportunity')
    } finally {
      setSaving(false)
    }
  }

  const handleUnlink = async () => {
    setSaving(true)
    try {
      const endpoint = itemType === 'job' ? `/api/jobs/${itemId}`
        : itemType === 'quote' ? `/api/quotes/${itemId}`
        : `/api/invoices/${itemId}`

      await patch(endpoint, { opportunity_id: null })

      if (onLinked) {
        onLinked(null)
      }

      setSelectedOppId(null)
    } catch (error) {
      console.error('Error unlinking from opportunity:', error)
      toast.error('Failed to unlink from opportunity')
    } finally {
      setSaving(false)
    }
  }

  const currentOpp = opportunities.find(o => o.id === selectedOppId)

  return (
    <div>
      {/* Button to open modal — plain hairline secondary, not a tinted trigger. */}
      <button
        onClick={() => setShowModal(true)}
        className="inline-flex items-center gap-2 px-3 py-2 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md text-sm font-medium transition-colors"
      >
        <Link2 className="w-4 h-4" />
        {currentOpportunityId ? 'Change Opportunity' : 'Link to Opportunity'}
      </button>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-panel rounded-xl shadow-lg max-w-lg w-full mx-4 max-h-[92dvh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-hairline">
              <h2 className="text-lg font-semibold text-ink">Link {itemType} to Opportunity</h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 hover:bg-bg-2 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-ink-3" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain">
              <div>
                <div className="text-sm text-ink-2 mb-1">Item</div>
                <div className="font-medium text-ink">{itemName || `${itemType} #${itemId}`}</div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader className="w-5 h-5 animate-spin text-ink-3" />
                </div>
              ) : opportunities.length === 0 ? (
                <div className="text-center py-8 text-ink-3">
                  <p className="text-sm">No opportunities found for this client</p>
                  <p className="text-xs mt-1">Create an opportunity first</p>
                </div>
              ) : (
                <div>
                  <div className="text-sm text-ink-2 mb-3">Select opportunity:</div>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {opportunities.map((opp) => (
                      <button
                        key={opp.id}
                        onClick={() => setSelectedOppId(opp.id)}
                        className={`w-full text-left p-3 rounded-lg border-2 bg-panel transition-colors ${
                          selectedOppId === opp.id
                            ? 'border-indigo-600'
                            : 'border-hairline hover:border-hairline-2'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="font-medium text-ink">{opp.title}</div>
                            <div className="text-sm text-ink-2 mt-1">
                              {opp.amount && `$${opp.amount.toLocaleString()}`}
                              {opp.probability && ` • ${opp.probability}% prob`}
                            </div>
                          </div>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ml-2 text-ink-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STAGE_DOTS[opp.stage] || 'bg-ink-3'}`} aria-hidden="true" />
                            {opp.stage}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Current link status — hairline card + dot, not a filled banner. */}
              {currentOpp && (
                <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-panel p-3">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">Currently linked</div>
                    <div className="text-xs text-ink-2 truncate">{currentOpp.title}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer — exactly one primary action (Link, filled indigo).
                Cancel and Unlink are both plain hairline secondaries so they
                don't compete with it for attention. */}
            <div className="flex gap-2 p-6 border-t border-hairline bg-bg">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 rounded-lg bg-panel border border-hairline-2 text-ink-2 font-medium hover:bg-bg-2 transition-colors"
              >
                Cancel
              </button>
              {currentOpp && (
                <button
                  onClick={handleUnlink}
                  disabled={saving}
                  className="flex-1 px-4 py-2 rounded-lg bg-panel border border-hairline-2 text-ink-2 font-medium hover:bg-bg-2 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Unlinking...' : 'Unlink'}
                </button>
              )}
              <button
                onClick={handleLink}
                disabled={!selectedOppId || saving}
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Linking...' : 'Link'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
