import { useState, useEffect } from 'react'
import { get, patch } from '../api'
import { X, Link2, Loader, CheckCircle } from 'lucide-react'

const STAGE_COLORS = {
  new:       'bg-amber-100 text-amber-700',
  qualified: 'bg-blue-100 text-blue-700',
  quoted:    'bg-purple-100 text-purple-700',
  won:       'bg-emerald-100 text-emerald-700',
  lost:      'bg-red-100 text-red-700',
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
      alert('Failed to link to opportunity')
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
      alert('Failed to unlink from opportunity')
    } finally {
      setSaving(false)
    }
  }

  const currentOpp = opportunities.find(o => o.id === selectedOppId)

  return (
    <div>
      {/* Button to open modal */}
      <button
        onClick={() => setShowModal(true)}
        className="inline-flex items-center gap-2 px-3 py-2 bg-purple-50 hover:bg-purple-100 text-purple-600 rounded-lg text-sm font-medium transition-colors"
      >
        <Link2 className="w-4 h-4" />
        {currentOpportunityId ? 'Change Opportunity' : 'Link to Opportunity'}
      </button>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full mx-4">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Link {itemType} to Opportunity</h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              <div>
                <div className="text-sm text-gray-600 mb-1">Item</div>
                <div className="font-medium text-gray-900">{itemName || `${itemType} #${itemId}`}</div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              ) : opportunities.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p className="text-sm">No opportunities found for this client</p>
                  <p className="text-xs mt-1">Create an opportunity first</p>
                </div>
              ) : (
                <div>
                  <div className="text-sm text-gray-600 mb-3">Select opportunity:</div>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {opportunities.map((opp) => (
                      <button
                        key={opp.id}
                        onClick={() => setSelectedOppId(opp.id)}
                        className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                          selectedOppId === opp.id
                            ? 'border-purple-500 bg-purple-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="font-medium text-gray-900">{opp.title}</div>
                            <div className="text-sm text-gray-600 mt-1">
                              {opp.amount && `$${opp.amount.toLocaleString()}`}
                              {opp.probability && ` • ${opp.probability}% prob`}
                            </div>
                          </div>
                          <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ml-2 ${STAGE_COLORS[opp.stage] || 'bg-gray-100 text-gray-700'}`}>
                            {opp.stage}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Current link status */}
              {currentOpp && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-emerald-900">Currently linked</div>
                    <div className="text-xs text-emerald-700">{currentOpp.title}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex gap-2 p-6 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              {currentOpp && (
                <button
                  onClick={handleUnlink}
                  disabled={saving}
                  className="flex-1 px-4 py-2 border border-red-300 bg-red-50 text-red-700 rounded-lg font-medium hover:bg-red-100 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Unlinking...' : 'Unlink'}
                </button>
              )}
              <button
                onClick={handleLink}
                disabled={!selectedOppId || saving}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
